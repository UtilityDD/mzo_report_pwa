Add-Type -AssemblyName System.Drawing

function Build-Icons($sourceRel, $suffix) {
    $srcPath = Join-Path $PSScriptRoot $sourceRel
    if (!(Test-Path $srcPath)) { return }
    $src = [System.Drawing.Image]::FromFile($srcPath)

    foreach ($size in @(192, 512)) {
        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        
        $pad = [int]($size * 0.04)
        $availW = $size - (2 * $pad)
        $availH = $size - (2 * $pad)
        
        $scale = [Math]::Min($availW / $src.Width, $availH / $src.Height)
        $w = [int]($src.Width * $scale)
        $h = [int]($src.Height * $scale)
        $x = [int](($size - $w) / 2)
        $y = [int](($size - $h) / 2)
        
        $g.DrawImage($src, $x, $y, $w, $h)
        
        $outPath = Join-Path $PSScriptRoot ("..\icons\icon-" + $size + $suffix + ".png")
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose()
        $bmp.Dispose()
    }
    $src.Dispose()
    Write-Host "Generated icons with suffix '$suffix' from $sourceRel"
}

Build-Icons "..\icons\disha-utility-distribution-logo.png" "-v2"
Build-Icons "..\icons\disha-dark.png" "-dark"
