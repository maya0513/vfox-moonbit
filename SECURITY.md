# Security Policy

Please report a vulnerability privately through GitHub's security advisory
form for `maya0513/vfox-moonbit`. Do not include credentials or unpublished
exploit details in a public issue.

The plugin downloads MoonBit only from `https://cli.moonbitlang.com`, verifies
the recorded SHA-256 before extracting core, and never redistributes upstream
binaries. Reports about the MoonBit binaries themselves should also be sent to
the MoonBit project. Reports about the vendored SHA implementation should
identify the pinned commit in `vendor-lock.json`.
