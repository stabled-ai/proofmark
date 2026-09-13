# Independent reproduction record

Give the reviewer only the public repository URL and this command:

```sh
git clone --recurse-submodules https://github.com/stabled-ai/proofmark.git
cd proofmark
npm ci
npm run verify:submission
```

The command is read-only. It sends no transaction and reads no private key.

## Reviewer record

- Reviewer name or public handle:
- Independent of the implementation team: yes / no
- Date/time and timezone:
- OS and architecture:
- Node version:
- Foundry/cast version:
- Commit tested:
- Start time:
- End time:
- `npm run verify:submission` result: pass / fail
- First failing output, if any:
- Instructions that were unclear:
- Changes required before a clean rerun:
- Clean rerun result and elapsed time:
- Reviewer confirmation/signature:

Do not fill this file on the reviewer's behalf. A blank template is preparation, not independent
reproduction evidence.
