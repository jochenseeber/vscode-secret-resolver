# Changelog

## 1.2.0 (2026-07-23)

### ⚠ BREAKING CHANGES

- OP_* variables (e.g. an ambient OP_SERVICE_ACCOUNT_TOKEN) are now stripped
  from the launch environment by default, and marker stripping is governed by
  the sanitize pattern instead of an unconditional rule. Set
  SECRET_RESOLVER_SANITIZE_VARS or the secretResolver.sanitizeVars setting to a
  custom pattern (or empty) to change this.

### Features

- add dynamic token and account selection
  ([d8af345](https://github.com/jochenseeber/vscode-secret-resolver/commit/d8af345bc4d23ab44ced9f4b7d49bc53241a3a86))
- add settings for account, token, and signal markers
  ([e57fb19](https://github.com/jochenseeber/vscode-secret-resolver/commit/e57fb192debe9aea8cbe142cdf6efcf6f1372446))
- add signal-on-stop support
  ([f9614ce](https://github.com/jochenseeber/vscode-secret-resolver/commit/f9614cecf5bd19de886dca690201c063d093340f))
- in-extension secret resolution
  ([078d0c5](https://github.com/jochenseeber/vscode-secret-resolver/commit/078d0c538dd181e6d0d25f638c4d7a2d6c76dfd8))
- resolve `op` references in debug launches
  ([8ec5aeb](https://github.com/jochenseeber/vscode-secret-resolver/commit/8ec5aeb32539938f8921c8e280c240d147d62a50))
- strip env vars by name with a sanitize pattern
  ([006e3db](https://github.com/jochenseeber/vscode-secret-resolver/commit/006e3dbfa417b164da3d50bdd4c74f283559e0a9))

### Bug Fixes

- escape regex metacharacters completely in release scripts
  ([617019e](https://github.com/jochenseeber/vscode-secret-resolver/commit/617019eedf1da80a3db1280ea0b9f58d4981cdc2))
- move the toolchain and build target to Node 22
  ([a575eab](https://github.com/jochenseeber/vscode-secret-resolver/commit/a575eab965ab789f7e65e9a96e54f7f3a43fc36a))
- override vulnerable axios and brace-expansion transitives
  ([76330c3](https://github.com/jochenseeber/vscode-secret-resolver/commit/76330c35ac580e93d7e5b975bbfa5527ae80d986))
- override vulnerable fast-uri transitive
  ([d7bacdb](https://github.com/jochenseeber/vscode-secret-resolver/commit/d7bacdbeb191225bbcde97d07237ca1bf267f2bb))

## 1.1.0 (2026-07-09)

### Features

- add dynamic token and account selection
  ([d8af345](https://github.com/jochenseeber/vscode-secret-resolver/commit/d8af345bc4d23ab44ced9f4b7d49bc53241a3a86))
- add signal-on-stop support
  ([f9614ce](https://github.com/jochenseeber/vscode-secret-resolver/commit/f9614cecf5bd19de886dca690201c063d093340f))
- in-extension secret resolution
  ([078d0c5](https://github.com/jochenseeber/vscode-secret-resolver/commit/078d0c538dd181e6d0d25f638c4d7a2d6c76dfd8))
- resolve `op` references in debug launches
  ([8ec5aeb](https://github.com/jochenseeber/vscode-secret-resolver/commit/8ec5aeb32539938f8921c8e280c240d147d62a50))

### Bug Fixes

- move the toolchain and build target to Node 22
  ([a575eab](https://github.com/jochenseeber/vscode-secret-resolver/commit/a575eab965ab789f7e65e9a96e54f7f3a43fc36a))

## [1.0.0](https://github.com/jochenseeber/vscode-secret-resolver/compare/8ec5aeb32539938f8921c8e280c240d147d62a50...v1.0.0) (2026-04-23)

### Features

- resolve `op` references in debug launches
  ([8ec5aeb](https://github.com/jochenseeber/vscode-secret-resolver/commit/8ec5aeb32539938f8921c8e280c240d147d62a50))
