# Fetch and build the bundled fonts.
#
#   .\scripts\fetch-fonts.ps1
#   .\scripts\fetch-fonts.ps1 -WorkDirectory C:\Temp\mdraft-fonts
#
# Run this only to upgrade the fonts. The woff2 files and fonts.json are
# committed, so an ordinary build needs neither this script, Python, nor a
# network connection.
#
# Every source is pinned by SHA-256 in scripts/font-sources.json and verified
# before anything is extracted or subset. A mismatch stops the script: a font
# that arrives silently different is a font nobody has reviewed the licence or
# the outlines of.
#
# The four archive families (Source Serif, Source Sans, JetBrains Mono, Fira
# Code) are extracted from their release zips exactly as before. The Google
# families are downloaded as variable TTFs and passed to subset-fonts.py, which
# instances and subsets them; IBM Plex Mono and Victor Mono are official woff2
# files copied unmodified. All families are under the SIL Open Font License 1.1,
# which permits bundling inside an application provided the copyright notice and
# licence text travel with them. That is why the licence files are copied next
# to the fonts, listed in fonts.json, and shown in the application.
#
# Python 3 with fonttools and brotli is required **only** by this maintenance
# script, never by the application build.

[CmdletBinding()]
param(
  # Where archives and source fonts are downloaded and unpacked.
  [string]$WorkDirectory = (Join-Path $env:TEMP "mdraft-fonts")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = Split-Path -Parent $PSScriptRoot
$fontDir = Join-Path $repoRoot "src\assets\fonts"
$licenceDir = Join-Path $fontDir "licenses"
$sourcesPath = Join-Path $PSScriptRoot "font-sources.json"
$subsetScript = Join-Path $PSScriptRoot "subset-fonts.py"

if (-not (Test-Path $sourcesPath)) {
  throw "missing source manifest: $sourcesPath"
}
$manifest = Get-Content $sourcesPath -Raw | ConvertFrom-Json

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  $python = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $python) {
  throw "Python 3 is required to refresh the Google families (fonttools + brotli)."
}

function Get-Sha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
  $actual = Get-Sha256 $Path
  if ($actual -ne $Expected) {
    throw @"
$Label does not match its pinned hash.
  expected $Expected
  actual   $actual
Refusing to continue. Either the source was republished, or the download is
damaged. Verify the new file by hand before updating the pin.
"@
  }
}

function Get-Source([string]$Url, [string]$Path) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "    downloading $(Split-Path -Leaf $Path)"
    Invoke-WebRequest $Url -OutFile $Path -TimeoutSec 600
  }
  return $Path
}

function Add-FontFile([string]$File, [string]$Style, [string]$Weight) {
  $target = Join-Path $fontDir $File
  return [ordered]@{
    file   = $File
    style  = $Style
    weight = $Weight
    bytes  = (Get-Item -LiteralPath $target).Length
    sha256 = Get-Sha256 $target
  }
}

New-Item -ItemType Directory -Path $WorkDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $fontDir -Force | Out-Null
New-Item -ItemType Directory -Path $licenceDir -Force | Out-Null

$families = @()

foreach ($family in $manifest.families) {
  Write-Host "==> $($family.name) $($family.tag)"
  $files = @()
  $entry = [ordered]@{
    id          = $family.id
    name        = $family.name
    tag         = $family.tag
    source      = $family.source
    licence     = $family.licence
    licenceFile = $family.licenceFile
  }

  switch ($family.kind) {
    "archive" {
      $zip = Get-Source $family.url (Join-Path $WorkDirectory $family.archive)
      Assert-Hash $zip $family.archiveSha256 $family.archive
      Write-Host "    archive verified"

      $handle = [IO.Compression.ZipFile]::OpenRead($zip)
      try {
        foreach ($pick in $family.picks) {
          $member = $handle.GetEntry($pick.entry)
          if (-not $member) {
            throw "$($family.archive) has no member $($pick.entry)"
          }
          $target = Join-Path $fontDir $pick.file
          [IO.Compression.ZipFileExtensions]::ExtractToFile($member, $target, $true)
          $files += Add-FontFile $pick.file $pick.style $pick.weight
          Write-Host ("    {0,-38} {1,7:N1} KB" -f $pick.file, ((Get-Item -LiteralPath $target).Length / 1KB))
        }

        $licenceName = Split-Path -Leaf $family.licenceFile
        $licencePath = Join-Path $licenceDir $licenceName
        if ($family.licenceUrl) {
          Get-Source $family.licenceUrl $licencePath | Out-Null
        } else {
          $member = $handle.GetEntry($family.licenceEntry)
          if (-not $member) {
            throw "$($family.archive) has no licence member $($family.licenceEntry)"
          }
          [IO.Compression.ZipFileExtensions]::ExtractToFile($member, $licencePath, $true)
        }
      } finally {
        $handle.Dispose()
      }

      $entry.archive = $family.archive
      $entry.archiveSha256 = $family.archiveSha256
    }

    "google" {
      foreach ($source in $family.sources) {
        $path = Get-Source $source.url (Join-Path $WorkDirectory "$($family.id)\$($source.file)")
        Assert-Hash $path $source.sha256 $source.file
        Write-Host "    source verified: $($source.file)"
      }

      $licenceName = Split-Path -Leaf $family.licenceFile
      Get-Source $family.licenceUrl (Join-Path $licenceDir $licenceName) | Out-Null

      foreach ($output in $family.outputs) {
        $source = $family.sources | Where-Object { $_.file -eq $output.source } | Select-Object -First 1
        if (-not $source) {
          throw "$($family.name) has no source named $($output.source)"
        }
        $sourcePath = Join-Path $WorkDirectory "$($family.id)\$($source.file)"
        $target = Join-Path $fontDir $output.file
        $arguments = @(
          $subsetScript,
          "--source", $sourcePath,
          "--output", $target
        )
        if ($output.instance) {
          $arguments += @("--instance", ($output.instance | ConvertTo-Json -Compress))
        }
        if ($output.layoutFeatures) {
          $arguments += @("--features", ($output.layoutFeatures -join ","))
        }
        if ($output.requiredFeatures) {
          $arguments += @("--require", ($output.requiredFeatures -join ","))
        }
        & $python.Source @arguments
        if ($LASTEXITCODE -ne 0) {
          throw "subset-fonts.py failed for $($output.file)"
        }
        $files += Add-FontFile $output.file $output.style $output.weight
      }
    }

    "woff2" {
      foreach ($source in $family.sources) {
        $path = Get-Source $source.url (Join-Path $WorkDirectory "$($family.id)\$($source.file)")
        Assert-Hash $path $source.sha256 $source.file
        Write-Host "    source verified: $($source.file)"
      }

      $licenceName = Split-Path -Leaf $family.licenceFile
      Get-Source $family.licenceUrl (Join-Path $licenceDir $licenceName) | Out-Null

      foreach ($output in $family.outputs) {
        $source = $family.sources | Where-Object { $_.file -eq $output.source } | Select-Object -First 1
        if (-not $source) {
          throw "$($family.name) has no source named $($output.source)"
        }
        $sourcePath = Join-Path $WorkDirectory "$($family.id)\$($source.file)"
        $target = Join-Path $fontDir $output.file
        if ($output.subset) {
          $arguments = @(
            $subsetScript,
            "--source", $sourcePath,
            "--output", $target
          )
          if ($output.layoutFeatures) {
            $arguments += @("--features", ($output.layoutFeatures -join ","))
          }
          if ($output.requiredFeatures) {
            $arguments += @("--require", ($output.requiredFeatures -join ","))
          }
          & $python.Source @arguments
          if ($LASTEXITCODE -ne 0) {
            throw "subset-fonts.py failed for $($output.file)"
          }
        } else {
          Copy-Item -LiteralPath $sourcePath -Destination $target -Force
        }
        $files += Add-FontFile $output.file $output.style $output.weight
        Write-Host ("    {0,-38} {1,7:N1} KB" -f $output.file, ((Get-Item -LiteralPath $target).Length / 1KB))
      }
    }

    default {
      throw "unknown family kind '$($family.kind)' for $($family.id)"
    }
  }

  $entry.files = $files
  $families += $entry
}

$catalogue = [ordered]@{
  note     = "Generated by scripts/fetch-fonts.ps1 from scripts/font-sources.json. Do not edit by hand."
  licence  = "All families are SIL Open Font License 1.1. See licenses/."
  families = $families
}

$json = $catalogue | ConvertTo-Json -Depth 10
Set-Content -Path (Join-Path $fontDir "fonts.json") -Value $json -Encoding UTF8

$fontFiles = Get-ChildItem $fontDir -File -Filter *.woff2
$total = ($fontFiles | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host ("==> {0} families, {1} files, {2:N0} KB" -f $families.Count, $fontFiles.Count, ($total / 1KB))
Write-Host "    wrote src/assets/fonts/fonts.json"
