<#
.SYNOPSIS
  portable\PomoSingle.exe に自己署名の Authenticode 署名を付ける。

.DESCRIPTION
  認証局を使わない「自己署名」なので、署名しても他の PC では
  「発行元を確認できません」のままで、SmartScreen の警告も消えない。
  それでも付けておく意味は 2 つ:
    - 改ざん検知。署名後に 1 バイトでも変われば「署名が無効」と出る
    - 会社 PC などで、書き出した .cer を「信頼されたルート証明機関」と
      「信頼された発行元」に入れれば、その PC ではプロパティの署名が
      「正常」になり、警告も出なくなる (入れる側に管理者権限が要る)

  証明書は初回に CurrentUser\My に作り、以後はそれを使い回す。
  公開鍵だけの .cer を portable\ に書き出すので、他の PC にはそれを渡す。
  秘密鍵はこの PC の証明書ストアから出ない。

.PARAMETER Subject
  証明書の名前 (CN)。署名のプロパティに「発行元」として出る。

.PARAMETER Years
  証明書の有効期間 (年)。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\sign-portable.ps1
#>
param(
  [string]$Subject = "PomoSingle (self-signed)",
  [int]$Years = 5,
  [string]$Exe = (Join-Path $PSScriptRoot "..\portable\PomoSingle.exe")
)

$ErrorActionPreference = "Stop"
$Exe = (Resolve-Path $Exe).Path
$cerOut = Join-Path (Split-Path $Exe) "PomoSingle-signing.cer"

# 既にあればそれを使う (毎回作ると、配った .cer と合わなくなる)
$cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -eq "CN=$Subject" -and $_.NotAfter -gt (Get-Date) } |
  Sort-Object NotAfter -Descending | Select-Object -First 1

if (-not $cert) {
  Write-Host "証明書を作ります: CN=$Subject ($Years 年)"
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=$Subject" `
    -KeyAlgorithm RSA -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation Cert:\CurrentUser\My `
    -NotAfter (Get-Date).AddYears($Years)
} else {
  Write-Host "証明書を使い回します: $($cert.Thumbprint) (期限 $($cert.NotAfter.ToString('yyyy-MM-dd')))"
}

# 他の PC に渡す公開鍵。秘密鍵は含まない
Export-Certificate -Cert $cert -FilePath $cerOut -Force | Out-Null
Write-Host "公開鍵を書き出しました: $cerOut"

# タイムスタンプを付けると、証明書の期限が切れた後も「署名した時点では
# 有効だった」として扱われる。付けないと期限切れと同時に署名も無効になる
$sig = Set-AuthenticodeSignature -FilePath $Exe -Certificate $cert `
  -HashAlgorithm SHA256 -TimestampServer "http://timestamp.digicert.com"

Write-Host "署名: $($sig.Status) — $Exe"
if ($sig.Status -ne "Valid" -and $sig.Status -ne "UnknownError") {
  # 自己署名なので、この PC でも信頼していなければ UnknownError
  # (= 信頼の連鎖が無い) になる。署名そのものは付いている
  Write-Warning $sig.StatusMessage
}
Write-Host ""
Write-Host "他の PC で「正常」にするには (管理者権限で):"
Write-Host "  certutil -addstore Root `"$cerOut`""
Write-Host "  certutil -addstore TrustedPublisher `"$cerOut`""
