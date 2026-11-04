# Security

Please report security problems through a private
[GitHub security advisory](https://github.com/okba-bouziane/anvil/security/advisories/new), not a public issue.

## What Anvil protects

- **API keys** are encrypted with the macOS Keychain and stay in the main process. The window never receives them.
- **File tools** the model uses can't leave the project folder, including through symbolic links, and can't change `.git`.
- **Commands** the model wants to run wait for your approval by default.
- **The window** runs sandboxed, with no Node access and a strict content policy. Text from the model is shown as text, never as HTML.

## What it can't protect

- Once you approve a command, or turn on **Auto-run commands**, it runs with your user's full permissions. It can read or delete anything your user can. Changes made by commands can't be undone from Anvil.
- A project can contain text written to mislead the model. Check what it proposes, especially in code you didn't write.
- With a cloud provider, the code the model reads is sent to that provider.
