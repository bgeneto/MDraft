# Fetch the bundled fonts. Run this only to upgrade them.
#
#   .\scripts\fetch-fonts.ps1
#
# The fonts themselves are committed, so an ordinary build never needs this
# script or a network connection. It exists so that the font set can be
# reproduced, audited and upgraded deliberately rather than by dropping files in
# from somewhere.
#
# Every archive is pinned by SHA-256 and verified before anything is extracted.
# A mismatch stops the script: a font that arrives silently different is a font
# nobody has reviewed the licence or the outlines of.
#
# All four families are under the SIL Open Font License 1.1, which permits
# bundling inside an application provided the copyright notice and the licence
# text travel with it. That is why the licence files are copied next to the
# fonts and listed in fonts.json, and why README.md names them.

[CmdletBinding()]
param(
  # Where the archives are downloaded and unpacked.
  [string]$WorkDirectory = (Join-Path $env:TEMP "mdraft-fonts")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = Split-Path -Parent $PSScriptRoot
$fontDir = Join-Path $repoRoot "src\assets\fonts"
$licenceDir = Join-Path $fontDir "licenses"

# The pinned archives. `Sha256` is of the archive as downloaded; a change here
# means somebody republished a release under the same tag, which is exactly the
# case this check exists to catch.
$archives = @(
  @{
    Id = "source-serif"; Family = "Source Serif 4"; Tag = "4.005R"
    Repo = "adobe-fonts/source-serif"
    Asset = "source-serif-4.005_WOFF2.zip"
    Sha256 = "af10e80dcd2296748b04cb9917db9f7ba0ae65101165fd2f0c16b9812d9abd28"
    LicenceUrl = "https://raw.githubusercontent.com/adobe-fonts/source-serif/4.005R/LICENSE.md"
    LicenceName = "source-serif-OFL.txt"
  }
  @{
    Id = "source-sans"; Family = "Source Sans 3"; Tag = "3.052R"
    Repo = "adobe-fonts/source-sans"
    Asset = "WOFF2-source-sans-3.052R.zip"
    Sha256 = "d7f6724027fe5ca0bab44d6121284f1fa8f66dec5f2864aa969aed347041ac95"
    LicenceUrl = "https://raw.githubusercontent.com/adobe-fonts/source-sans/3.052R/LICENSE.md"
    LicenceName = "source-sans-OFL.txt"
  }
  @{
    Id = "inter"; Family = "Inter"; Tag = "v4.1"
    Repo = "rsms/inter"
    Asset = "Inter-4.1.zip"
    Sha256 = "9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e"
    LicenceUrl = $null            # taken from inside the archive
    LicenceEntry = "LICENSE.txt"
    LicenceName = "inter-OFL.txt"
  }
  @{
    Id = "jetbrains-mono"; Family = "JetBrains Mono"; Tag = "v2.304"
    Repo = "JetBrains/JetBrainsMono"
    Asset = "JetBrainsMono-2.304.zip"
    Sha256 = "6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf"
    LicenceUrl = $null
    LicenceEntry = "OFL.txt"
    LicenceName = "jetbrains-mono-OFL.txt"
  }
  # Fira Code, for the editor. The plain release, not the Nerd Font build: the
  # Nerd Font variant is a mono plus thousands of icon glyphs and costs several
  # times as much for something this application never draws. What makes Fira
  # Code worth having is the programming ligatures, and they are in both.
  @{
    Id = "fira-code"; Family = "Fira Code"; Tag = "6.2"
    Repo = "tonsky/FiraCode"
    Asset = "Fira_Code_v6.2.zip"
    Sha256 = "0949915ba8eb24d89fd93d10a7ff623f42830d7c5ffc3ecbf960e4ecad3e3e79"
    # The zip carries no licence file at all; the licence lives in the repository.
    LicenceUrl = "https://raw.githubusercontent.com/tonsky/FiraCode/6.2/LICENSE"
    LicenceEntry = $null
    LicenceName = "fira-code-OFL.txt"
  }
)

# Which members to keep, and what to call them. Only the faces the application
# can actually use: 400 and 700 for families shipped as static weights, and the
# variable file where one exists, because that carries the whole weight axis and
# the optical-size axis Source Serif is designed around.
$picks = @{
  "source-serif" = @(
    @{ Entry = "source-serif-4.005_WOFF2/VAR/SourceSerif4Variable-Roman.ttf.woff2";  File = "SourceSerif4-Variable-Roman.woff2";  Style = "normal"; Weight = "200 900" }
    @{ Entry = "source-serif-4.005_WOFF2/VAR/SourceSerif4Variable-Italic.ttf.woff2"; File = "SourceSerif4-Variable-Italic.woff2"; Style = "italic"; Weight = "200 900" }
  )
  "source-sans" = @(
    @{ Entry = "WOFF2/TTF/SourceSans3-Regular.ttf.woff2"; File = "SourceSans3-Regular.woff2"; Style = "normal"; Weight = "400" }
    @{ Entry = "WOFF2/TTF/SourceSans3-Bold.ttf.woff2";    File = "SourceSans3-Bold.woff2";    Style = "normal"; Weight = "700" }
    @{ Entry = "WOFF2/TTF/SourceSans3-It.ttf.woff2";      File = "SourceSans3-Italic.woff2";  Style = "italic"; Weight = "400" }
    @{ Entry = "WOFF2/TTF/SourceSans3-BoldIt.ttf.woff2";  File = "SourceSans3-BoldItalic.woff2"; Style = "italic"; Weight = "700" }
  )
  "inter" = @(
    @{ Entry = "web/InterVariable.woff2";        File = "Inter-Variable.woff2";        Style = "normal"; Weight = "100 900" }
    @{ Entry = "web/InterVariable-Italic.woff2"; File = "Inter-Variable-Italic.woff2"; Style = "italic"; Weight = "100 900" }
  )
  "jetbrains-mono" = @(
    @{ Entry = "fonts/webfonts/JetBrainsMono-Regular.woff2";  File = "JetBrainsMono-Regular.woff2";  Style = "normal"; Weight = "400" }
    @{ Entry = "fonts/webfonts/JetBrainsMono-Bold.woff2";     File = "JetBrainsMono-Bold.woff2";     Style = "normal"; Weight = "700" }
    @{ Entry = "fonts/webfonts/JetBrainsMono-Italic.woff2";   File = "JetBrainsMono-Italic.woff2";   Style = "italic"; Weight = "400" }
    @{ Entry = "fonts/webfonts/JetBrainsMono-BoldItalic.woff2"; File = "JetBrainsMono-BoldItalic.woff2"; Style = "italic"; Weight = "700" }
  )
  # One file, not four. The variable build carries the whole 300–700 range for
  # 110 KB, where Regular plus Bold alone would be 206 KB and still leave the
  # editor without the intermediate weights. Fira Code has no italics of its own,
  # so the browser slants the upright — which is what every editor does with it.
  "fira-code" = @(
    @{ Entry = "woff2/FiraCode-VF.woff2"; File = "FiraCode-Variable.woff2"; Style = "normal"; Weight = "300 700" }
  )
}

$sha256 = { param($Path) (Get-FileHash $Path -Algorithm SHA256).Hash.ToLower() }

New-Item -ItemType Directory -Path $WorkDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $fontDir -Force | Out-Null
New-Item -ItemType Directory -Path $licenceDir -Force | Out-Null

$families = @()

foreach ($archive in $archives) {
  $url = "https://github.com/$($archive.Repo)/releases/download/$($archive.Tag)/$($archive.Asset)"
  $zip = Join-Path $WorkDirectory $archive.Asset

  Write-Host "==> $($archive.Family) $($archive.Tag)"
  if (-not (Test-Path $zip)) {
    Invoke-WebRequest $url -OutFile $zip -TimeoutSec 600
  }

  $actual = & $sha256 $zip
  if ($actual -ne $archive.Sha256) {
    throw @"
$($archive.Asset) does not match its pinned hash.
  expected $($archive.Sha256)
  actual   $actual
Refusing to extract. Either the release was republished, or the download is
damaged. Verify the new archive by hand before updating the pin.
"@
  }
  Write-Host "    archive verified"

  $handle = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $files = @()
    foreach ($pick in $picks[$archive.Id]) {
      $entry = $handle.GetEntry($pick.Entry)
      if (-not $entry) { throw "$($archive.Asset) has no member $($pick.Entry)" }
      $target = Join-Path $fontDir $pick.File
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      $files += [ordered]@{
        file   = $pick.File
        style  = $pick.Style
        weight = $pick.Weight
        bytes  = (Get-Item $target).Length
        sha256 = & $sha256 $target
      }
      Write-Host ("    {0,-34} {1,7:N0} KB" -f $pick.File, ((Get-Item $target).Length / 1KB))
    }

    $licencePath = Join-Path $licenceDir $archive.LicenceName
    if ($archive.LicenceUrl) {
      Invoke-WebRequest $archive.LicenceUrl -OutFile $licencePath -TimeoutSec 60
    } else {
      $entry = $handle.GetEntry($archive.LicenceEntry)
      if (-not $entry) { throw "$($archive.Asset) has no licence member $($archive.LicenceEntry)" }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $licencePath, $true)
    }
  } finally {
    $handle.Dispose()
  }

  $families += [ordered]@{
    id          = $archive.Id
    name        = $archive.Family
    tag         = $archive.Tag
    source      = "https://github.com/$($archive.Repo)"
    licence     = "OFL-1.1"
    licenceFile = "licenses/$($archive.LicenceName)"
    archive     = $archive.Asset
    archiveSha256 = $archive.Sha256
    files       = $files
  }
}

# The record the application reads: which families exist, what they are for and
# which files belong to each. Hand-written role guidance lives beside it in
# src/fonts.ts, because "which family suits a heading" is editorial, not
# something to infer from a file listing.
$catalogue = [ordered]@{
  note       = "Generated by scripts/fetch-fonts.ps1. Do not edit by hand."
  licence    = "All families are SIL Open Font License 1.1. See licenses/."
  families   = $families
}

$json = $catalogue | ConvertTo-Json -Depth 8
Set-Content -Path (Join-Path $fontDir "fonts.json") -Value $json -Encoding UTF8

# Measured from disk rather than summed from the catalogue: a dictionary's
# members are not visible to Measure-Object -Property, which silently reports 0.
$fontFiles = Get-ChildItem $fontDir -File -Filter *.woff2
$total = ($fontFiles | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host ("==> {0} families, {1} files, {2:N0} KB" -f $families.Count, $fontFiles.Count, ($total / 1KB))
Write-Host "    wrote src/assets/fonts/fonts.json"
