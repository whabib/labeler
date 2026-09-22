<h1 align="center">labeler</h1>

A lightweight alternative to Ozone for operating an atproto labeler.

Forked from [skyware-js/labeler](https://github.com/skyware-js/labeler).

## CLI

The `labeler` package also comes with a CLI for setting up and managing a labeler.

```sh
$ npx github:whabib/labeler
Usage: npx github:whabib/labeler [command]
Commands:
  setup - Initialize an account as a labeler.
  clear - Restore a labeler account to normal.
  recreate - Recreate the labeler declaration (recommended if labels are not showing up).
  label add - Add new label declarations to a labeler account.
  label delete - Remove label declarations from a labeler account.
  label edit - Bulk edit label definitions.
```

To set up a new labeler account, run the `setup` command above.

## Installation

```sh
npm install github:whabib/labeler
```

## Example Usage

This library requires an existing labeler declaration. To get set up, use the `setup` command of the [CLI](#cli).

```js
import { LabelerServer } from "labeler";

const server = new LabelerServer({ did: "···", signingKey: "···" });

server.start(14831, (error, address) => {
    if (error) {
        console.error(error);
    } else {
        console.log(`Labeler server listening on ${address}`);
    }
});
```
