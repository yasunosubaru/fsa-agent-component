# Capture what the user actually sees inside the app window.
#
# A guest panel is an *owned* window, so it draws above its owner. Raising the
# owner therefore raises the panel with it, and a screen grab of the owner's
# rectangle is an honest record of the panel as displayed.
#
# PrintWindow cannot be used instead: Electron and Obsidian create their windows
# with WS_EX_NOREDIRECTIONBITMAP (no compositor bitmap), so PrintWindow returns
# black for a window that is plainly visible on screen.
#
# Arguments:
#   -Title     window title of the host window to photograph
#   -OutFile   destination PNG path
# Usage:
#   powershell -File shoot-window.ps1 -Title AgentDeck -OutFile C:\x\shot.png

param(
  [string]$Title = 'AgentDeck',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

if (-not $OutFile) { Write-Output 'NO_OUTFILE'; exit 2 }

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Shot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool f);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr ByTitle(string t) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new System.Text.StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString() == t) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

[Shot]::SetProcessDPIAware() | Out-Null

$h = [Shot]::ByTitle($Title)
if ($h -eq [IntPtr]::Zero) { Write-Output 'NO_HOST_WINDOW'; exit 3 }

# Take the foreground so nothing else covers the host or its owned panels.
$fg = [Shot]::GetForegroundWindow()
$dummy = 0
$fgThread = [Shot]::GetWindowThreadProcessId($fg, [ref]$dummy)
$meThread = [Shot]::GetCurrentThreadId()
[Shot]::AttachThreadInput($meThread, $fgThread, $true) | Out-Null
[Shot]::ShowWindow($h, 9) | Out-Null
[Shot]::BringWindowToTop($h) | Out-Null
[Shot]::SetForegroundWindow($h) | Out-Null
[Shot]::AttachThreadInput($meThread, $fgThread, $false) | Out-Null

# Owned windows are raised with the owner, but the compositor needs a moment.
Start-Sleep -Milliseconds 1500

$r = New-Object Shot+RECT
[Shot]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { Write-Output "BAD_SIZE $w x $ht"; exit 4 }

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
$g.Dispose()

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)

# Distinct colours: a blank grab collapses to one or two, so this doubles as the
# check that the panel really painted something.
$colors = @{}
for ($y = 0; $y -lt $bmp.Height; $y += 17) {
  for ($x = 0; $x -lt $bmp.Width; $x += 17) { $colors[$bmp.GetPixel($x, $y).ToArgb()] = 1 }
}
$distinct = $colors.Count

$bmp.Dispose()
Write-Output "OK ${w}x${ht} distinct=$distinct"
