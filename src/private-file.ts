import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const windowsCheck = String.raw`
$ErrorActionPreference = 'Stop'
$file = $env:ETH_TOKEN_BOT_PRIVATE_FILE
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$sid = [Security.Principal.SecurityIdentifier]
$acl = Get-Acl -LiteralPath $file
if ($acl.GetOwner($sid).Value -ne $user.Value) { throw 'File owner differs from the bot account' }
if (!$acl.AreAccessRulesProtected) { throw 'File inherits access rules' }
foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $user.Value) {
        throw 'Another principal has file access'
    }
}
`;

// The .NET Framework FileStream overload applies the private ACL atomically at file creation.
const windowsCreate = String.raw`
$ErrorActionPreference = 'Stop'
$file = $env:ETH_TOKEN_BOT_PRIVATE_FILE
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
if (Test-Path -LiteralPath $file) { exit 17 }
$stream = [IO.FileStream]::new($file, 'CreateNew', 'Write', 'None', 4096, 'WriteThrough', $acl)
try {
    [Console]::OpenStandardInput().CopyTo($stream)
    $stream.Flush($true)
} finally {
    $stream.Dispose()
}
`;

function windowsPrivateFile(file: string, contents?: string) {
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (path.basename(file).includes(':')) throw new Error('Use a regular NTFS file');
  try {
    execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', contents === undefined ? windowsCheck : windowsCreate], {
      input: contents, stdio: [contents === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], windowsHide: true, timeout: 10_000,
      env: { ...process.env, ETH_TOKEN_BOT_PRIVATE_FILE: path.resolve(file) },
    });
  } catch (error) {
    if ((error as { status?: number }).status === 17) {
      throw Object.assign(new Error('The destination file already exists'), { code: 'EEXIST' });
    }
    throw new Error('Could not verify owner-only file permissions. Use a private NTFS file with access restricted to the bot account.');
  }
}

export function readPrivateFile(file: string, maxBytes: number): string {
  if (process.platform === 'win32' && !fs.lstatSync(file).isFile()) throw new Error('Expected a regular private file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid private file');
    if (process.platform === 'win32') windowsPrivateFile(file);
    else if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('Private file must be owned by the bot account and readable only by that account (chmod 600)');
    }
    const data = Buffer.alloc(maxBytes + 1);
    const bytes = fs.readSync(fd, data, 0, data.length, 0);
    if (bytes > maxBytes) throw new Error('Invalid private file');
    return data.toString('utf8', 0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/** Create exclusively and apply owner-only permissions at creation. */
export function writePrivateFile(file: string, contents: string) {
  if (process.platform === 'win32') return windowsPrivateFile(file, contents);
  const fd = fs.openSync(file, 'wx', 0o600);
  let complete = false;
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    complete = true;
  } finally {
    fs.closeSync(fd);
    if (!complete) {
      try { fs.unlinkSync(file); } catch { /* preserve the write error */ }
    }
  }
}
