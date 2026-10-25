# A ten-minute demo

For showing the project to someone. It uses a real model on a real computer. The classifier points at clause types; it is not a verdict on any company, so choose pages you are happy to discuss on those terms. You need a computer with a WebGPU-capable browser, the repository set up as in the [README](../README.md), and model bundles in `data/models`.

## Before you start

```bash
bun install && bun run build
bun run auth add demo                # a contributor account
bun run server                       # http://localhost:8787
```

Load `packages/extension/dist` in Chromium (`chrome://extensions`, developer mode, **Load unpacked**). Any site's public terms page will do for the reading steps, for example GitHub's terms of service.

## 1. The setup (2 minutes)

The setup page opens by itself. Say what it is: a model is about to be downloaded from *our* server into the browser, and nothing is bundled in the extension.

- **Check this computer** shows the graphics card and the free storage. Point out the problem message you would get without WebGPU, and the **Use shared results only** option below it.
- **Choose a model**: Fast (about 0.4 GB) is pre-selected. The larger one is a choice for later.
- **Download**, then the **quick test**: five questions the model answers on the spot, three clauses and two pages.
- **Two optional extras**: summaries off by default, and the contributor sign-in. Sign in as `demo`.

## 2. Reading terms on the device (3 minutes)

Open a site's terms page. Click the toolbar icon, then **Read the terms**.

- Watch the **document strip** fill in as the model reads: one tick per sentence, the flagged ones tall and coloured by family.
- Click a family chip to filter. Click the strip to jump to a clause.
- Open the browser's network panel: no request carries the page text. Point at "Running on your computer".
- Below the chips, **In short** gives three to five plain-English points with a risk level, and the **Money** chip lists renewals, fees and refunds (found by fixed patterns, not the model). Press **Find similar cases** to see which other sites have a clause like each one.
- Because you are a contributor, the popup now asks **Share this result?** and lists exactly what would be sent. Nothing has been sent yet: that is the point to make. Press **Share** for the next step, or **Not now** to show that nothing leaves.

## 3. The shared result (1 minute)

Open the same page in a second browser profile with the extension set up (or clear the extension's saved results in the browser's extension storage) and press the icon again. It answers from the public cache in about half a second, labelled "from the public cache".

## 3b. A site with no terms (1 minute)

Open `https://www.quickloan-demo.com/signup` from the fixtures (`bun run fixtures`). The page asks for a card and links no terms or privacy policy, so a **Caution** banner appears at once, with **Report this site**. Press the toolbar icon and **Read the terms**: nothing is found, so the on-device model reads the page's own fine print and the banner is redrawn with what it found. Press **Report this site**; the home page of the results server then lists the site under "Reported as having no terms".

## 4. A page that shows personal data (1 minute)

Do not use a real account page. The test suite has an invented one: run `bun run e2e:analysis --headed` and watch scenario D, where the page shows a made-up shopper's name and email. The extension still classifies on the device but **does not look anything up and does not share**, and says why without repeating the address it found.

## 5. The public site (2 minutes)

Open `http://localhost:8787`. Search a site you just read. Show the ranking, the clauses in quotes, the filters, and the earlier versions of a document. Open `/docs` and press **Try it** on an endpoint.

## 6. Optional extras

- **Shared results only.** Start a browser with no GPU flags, or choose it on the setup page. The popup says "Look up results", sends only the site's name, and says plainly when nobody has read a site.
- **The form warning.** Run `bun run fixtures` and open one of the phishing fixtures it lists (for example `secure-paypa1.xyz`, with the flags it prints): a red banner explains in plain words why the form looks like phishing.

## If something does not work

See "When something is wrong" in [operations.md](operations.md). The usual one: after rebuilding the extension, reload it at `chrome://extensions`.
