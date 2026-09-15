param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\assets'))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

function New-RoundedRectanglePath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-LocalBoardPng([int]$Size) {
  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $margin = [Math]::Max(1, [Math]::Round($Size * 0.045))
    $side = $Size - 2 * $margin
    $path = New-RoundedRectanglePath $margin $margin $side $side ([Math]::Max(2, $Size * 0.20))
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 15, 108, 189))
    try { $graphics.FillPath($brush, $path) } finally { $brush.Dispose(); $path.Dispose() }

    $fontSize = [Math]::Max(7, $Size * 0.35)
    $font = [System.Drawing.Font]::new('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $format = [System.Drawing.StringFormat]::new()
    try {
      $format.Alignment = [System.Drawing.StringAlignment]::Center
      $format.LineAlignment = [System.Drawing.StringAlignment]::Center
      $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
      $rect = [System.Drawing.RectangleF]::new(0, -$Size * 0.025, $Size, $Size)
      $graphics.DrawString('LB', $font, $textBrush, $rect, $format)
    } finally {
      $format.Dispose(); $textBrush.Dispose(); $font.Dispose()
    }

    $stream = [System.IO.MemoryStream]::new()
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return $stream.ToArray()
  } finally {
    $graphics.Dispose(); $bitmap.Dispose()
  }
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$images = foreach ($size in $sizes) { [pscustomobject]@{ Size = $size; Bytes = (New-LocalBoardPng $size) } }
[System.IO.File]::WriteAllBytes((Join-Path $OutputDirectory 'icon.png'), ($images | Where-Object Size -eq 256).Bytes)

$iconPath = Join-Path $OutputDirectory 'icon.ico'
$stream = [System.IO.File]::Open($iconPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = [System.IO.BinaryWriter]::new($stream)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$images.Count)
  $offset = 6 + 16 * $images.Count
  foreach ($image in $images) {
    $writer.Write([byte]($(if ($image.Size -eq 256) { 0 } else { $image.Size })))
    $writer.Write([byte]($(if ($image.Size -eq 256) { 0 } else { $image.Size })))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$image.Bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $image.Bytes.Length
  }
  foreach ($image in $images) { $writer.Write([byte[]]$image.Bytes) }
} finally {
  $writer.Dispose(); $stream.Dispose()
}

Write-Output "Generated $iconPath and icon.png"
