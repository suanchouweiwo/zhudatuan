param(
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$BuildTools = 'D:/kehuduan/zhudatuan-android/tools/android-16',
    [string]$Jdk = 'C:/Program Files/Android/Android Studio/jbr',
    [string]$Output = 'D:/kehuduan/zhudatuan-android/zhudatuan-android-debug.apk'
)

$ErrorActionPreference = 'Stop'

function Invoke-BuildTool {
    param([string]$Tool, [string[]]$Arguments)
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$(Split-Path -Leaf $Tool) exited with code $LASTEXITCODE."
    }
}

$androidJar = Join-Path $AndroidSdk 'platforms/android-36/android.jar'
$jdkBin = Join-Path $Jdk 'bin'
$java = Join-Path $jdkBin 'java.exe'
$aapt = Join-Path $BuildTools 'aapt2.exe'
$d8 = Join-Path $BuildTools 'lib/d8.jar'
$signer = Join-Path $BuildTools 'lib/apksigner.jar'
$debugKey = Join-Path $env:LOCALAPPDATA 'Zhudatuan/Android/debug.keystore'
$outputFile = [IO.Path]::GetFullPath($Output)
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ('zhudatuan-apk-' + [guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Path $buildRoot | Out-Null
try {
    $resources = Join-Path $buildRoot 'res'
    $icons = Join-Path $resources 'drawable-nodpi'
    $generated = Join-Path $buildRoot 'generated'
    $classes = Join-Path $buildRoot 'classes'
    $dex = Join-Path $buildRoot 'dex'
    New-Item -ItemType Directory -Path $icons,$generated,$classes,$dex -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'res/values') -Destination $resources -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../storefront-web/app/icon2.png') -Destination (Join-Path $icons 'storefront.png')

    $compiled = Join-Path $buildRoot 'resources.zip'
    $unsigned = Join-Path $buildRoot 'unsigned.apk'
    Invoke-BuildTool $aapt @('compile','--dir',$resources,'-o',$compiled)
    Invoke-BuildTool $aapt @('link','-I',$androidJar,'--manifest',(Join-Path $PSScriptRoot 'AndroidManifest.xml'),
        '--java',$generated,'--min-sdk-version','24','--target-sdk-version','36',
        '--version-code','1','--version-name','0.1.0','-o',$unsigned,$compiled)

    $sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src'),$generated -Recurse -Filter '*.java' |
        Select-Object -ExpandProperty FullName)
    Invoke-BuildTool (Join-Path $jdkBin 'javac.exe') (@('--release','8','-encoding','UTF-8',
        '-classpath',$androidJar,'-d',$classes) + $sources)
    $classArchive = Join-Path $buildRoot 'classes.jar'
    Invoke-BuildTool (Join-Path $jdkBin 'jar.exe') @('--create','--file',$classArchive,'-C',$classes,'.')
    Invoke-BuildTool $java @('-cp',$d8,'com.android.tools.r8.D8','--min-api','24','--lib',$androidJar,'--output',$dex,$classArchive)
    Invoke-BuildTool (Join-Path $jdkBin 'jar.exe') @('--update','--no-manifest','--file',$unsigned,'-C',$dex,'classes.dex')

    $aligned = Join-Path $buildRoot 'aligned.apk'
    Invoke-BuildTool (Join-Path $BuildTools 'zipalign.exe') @('-f','4',$unsigned,$aligned)
    if (-not (Test-Path -LiteralPath $debugKey)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $debugKey) -Force | Out-Null
        Invoke-BuildTool (Join-Path $jdkBin 'keytool.exe') @('-genkeypair','-keystore',$debugKey,
            '-storepass','android','-keypass','android','-alias','androiddebugkey','-keyalg','RSA',
            '-keysize','2048','-validity','10000','-dname','CN=Android Debug,O=Android,C=US')
    }
    $signed = Join-Path $buildRoot 'signed.apk'
    Invoke-BuildTool $java @('-jar',$signer,'sign','--ks',$debugKey,'--ks-pass','pass:android',
        '--ks-key-alias','androiddebugkey','--out',$signed,$aligned)
    New-Item -ItemType Directory -Path (Split-Path -Parent $outputFile) -Force | Out-Null
    Copy-Item -LiteralPath $signed -Destination $outputFile -Force
    Write-Output $outputFile
} finally {
    $resolvedRoot = (Resolve-Path -LiteralPath $buildRoot).Path
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse
    }
}
