# Threat model

What the project protects, from whom, how, and what it does not protect. Written for a reader deciding whether to run it, contribute to it or host it. The design it refers to is in [architecture.md](architecture.md).

## What leaves the device

This is the most important table, because most of the design exists to keep it short.

| Situation | What is sent, and to whom |
|---|---|
| The model reads a page on the device | **Nothing.** The text stays in the browser. |
| Asking whether a document was already read (on-device mode) | The address of the terms document, with query and fragment removed, and a hash of its text, to the configured results server. Only after the personal-data rules pass. |
| Shared-results-only mode | The registrable domain of a public site (for example `example.com`), to the results server, then the numeric id of the result it shows (to ask for similar clauses). If nothing is stored, the domain again, to ask whether others reported the site as having no terms. No path, no text. |
| Sharing a result (contributor signed in, page passed both personal-data checks, **and the user pressed Share**) | The address (no query or fragment), the text hash, the model id, the **flagged sentences** with their probabilities, and the sentences the fee rules matched. Fair sentences are sent only as a count. The Share card lists this before anything is sent. |
| Find similar cases (a result read on this device) | Only when the user presses the button: the flagged sentences (at most 50, personal-looking ones removed), the clause types and the registrable domain of the page. For a stored result, only its id. |
| Report this site (no terms found) | Only when the user presses the button, from any user: the page address (no query or fragment) and the same-site addresses that were checked for terms. |
| A read finds no terms | The registrable domain, to ask whether others have reported the site (`GET /api/v1/missing-terms/<domain>`). The page's own text is read on the device and is never sent. |
| Plain-language summary (opted in at setup) | The flagged sentences of a page that passed both checks, to the results server, or to the user's own endpoint if they chose that. |
| First setup and settings | The browser requests the model files and manifest from the configured server. A sign-in sends the contributor's username and password to that server once. |
| Form warning | Nothing is sent anywhere. One optional request is made: when a page already looks suspicious, the site's own icon is fetched from the site the user is on, once a month per domain, and compared locally. It can be turned off in settings. |

The results server therefore learns, from a user who is not a contributor and not using summaries: which public documents they ask about (on-device mode) or which public sites (shared mode), and their network address, like any web server. It does not learn page contents.

## Assets

1. **What a user reads and what a page shows them**: their browsing and any personal data on the pages.
2. **Contributor credentials**: the password and the bearer token.
3. **The integrity of the shared results**: people will trust them.
4. **The model files**: they run in every user's browser.
5. **The server's resources**: model bandwidth, and the money behind the optional summary endpoint.
6. **A user's own endpoint key**, if they use their own summary endpoint.

## Who might attack

- **A website** that a user visits, trying to mislead the classifier, the summary or the interface.
- **A contributor**, honest or not, who can upload results.
- **An anonymous visitor** of the server or the site.
- **A network attacker** between a user and the server.
- **The server operator**, who is trusted with the above table but should not need to be trusted with more.

Out of scope: a compromised browser, extension store account or operating system; side channels in the GPU; the providers of Qwen, Kev, WebLLM or the user's chosen language-model endpoint.

## Threats and what answers them

### Personal data leaving the device

The extension might upload a result, or ask for a summary, about a page that shows the user's own data (an account page, an order, a statement).

- **Two independent checks before anything is sent**: deterministic rules (consumer-provider email addresses, payment-card numbers that pass the Luhn check, national ID formats, IBANs, dates of birth, signed-in markers; company contact details on a policy page do not count) and a model question about the whole page. Either one stops the upload.
- **The rules run first**, before even the cache lookup, so a page that looks personal never causes a request about it.
- **Every passage is checked again** with a stricter rule set before it is sent, and the **server checks it a third time** and refuses the upload.
- **Findings carry counts and kinds, never the values.**

Remaining risk: the checks can miss. Rules cannot recognise personal data in a format they do not know, and the model check was measured on synthetic pages, where it missed about 4% of personal pages (see [evaluation.md](evaluation.md)). The uploaded text is limited to sentences the classifier flagged as clauses of a terms document, which narrows what could go wrong, but a personal sentence on a page that looks like terms would pass. Treat sharing as something only for public terms pages.

### A malicious website

- **Hiding text from the model, or planting text only the model sees.** Text is taken from what the page renders: content hidden by styles, off-screen, zero-sized, `aria-hidden` or in comments is dropped before classification (`shared/sanitize.ts`). Pages rendered by script are read in a hidden tab, after their own scripts ran.
- **Prompt injection in a sentence** ("ignore the above and answer I"). The classifier does not generate text: it answers a fixed multiple-choice question and the code reads nine numbers. The worst a sentence can do is be labelled as something else, including "other". **A model talked into silence cannot be forced to speak**, so a clean result is never a guarantee, and this is stated in the popup.
- **Prompt injection in the summary.** Flagged passages from a page reach a language model. The risk score is computed from severities in code, never asked of the model, and every quote the model returns must appear word for word in the submitted passages or it is dropped.
- **Scripts or markup in a passage.** Passages are rendered as text only, in the popup and on the query site. A test feeds a passage containing `<img onerror>` and `<script>` through the site and checks that nothing is created or run; the popup has a similar test (`no-html-injection`).
- **Fake forms and phishing.** The form warning scores sensitive fields, destinations on other domains, look-alike domains and cheap top-level domains. It is rules only and can be wrong in both directions.

### What the form warning reads

The page-level checks look at the **text of the page's scripts** (never run) and at the **addresses of requests the page has made**. Both stay in the browser: they go from the content script to the service worker and no further, and the schema for anything sent to a server has no field for them.

- **No new permissions.** The list of contacted hosts comes from the browser's resource timing, which shows addresses and no request bodies. A permission such as `webRequest` was considered and rejected: it would not show bodies either.
- **Nothing on the page is run to find out.** Detecting that a page blocks developer tools by sending it a synthetic F12 key press would run the page's own handlers, so the check reads the scripts' text instead.
- **The icon request** is the only request the warning makes by itself. It goes to the site the user is already on, never to a third party, only when the page already scored something, at most once a month per domain, and the image is decoded in the service worker (an image, not a document: nothing is parsed as markup). The setting "Check site icons" turns it off.

### A malicious or mistaken contributor

Contributors are **trusted**. That is a design choice, not a control, and it is the largest gap.

- A contributor can upload a wrong result for any public address, and "latest wins" makes it the current one until another upload replaces it. Older results stay as history until they expire.
- The server does not verify the text hash or re-run the classification, so it cannot tell an honest result from an invented one. It checks shape (strict schema, probabilities that sum to one, category equal to the most likely class), that the host is a public one and matches the domain, and that no passage looks personal.
- Uploads are limited to 1 MB and 500 flagged passages each. There is **no per-contributor upload rate limit**.
- Results expire after 30 days, which bounds the damage of any single bad upload. There is **no moderation or takedown tool**; today, the operator deletes rows in the database.
- The results store which contributor uploaded each row, but the public API does not show it.

Mitigation options not yet built: signed or re-checked results, a second contributor's agreement before a result becomes current, a takedown command, per-account limits.

### Anonymous reports and searches

The missing-terms report and the similar-case search are open to anyone, because the people who notice are not contributors.

- **What a report can do is small**: add one to a count for a site (30 days from the last report). It stores no reporter identity, no page text, and only same-site addresses. A site that already has a shared result is refused.
- **Limits**: one report per client per site per day (a repeat is acknowledged, not counted), 30 reports per client per hour and 300 overall; 60 searches per client per hour. Like the summary limits, these use the client address, so see `PPG_TRUST_PROXY` below.
- **What it cannot stop**: one person with many addresses can inflate a count, and a wrong report ("this site has no terms") can put a warning in front of other users for up to 30 days. There is no takedown tool, as for results. The popup words it as "someone has reported", never as a fact.
- **Web pages cannot file one for a user**: writes answer only extension origins, the on-page Report button takes only trusted clicks (`event.isTrusted`), and the address sent is the browser's own record of the tab, not something the page supplied.

### Contributor credentials

- Passwords are stored as bcrypt hashes in `auth.txt` (gitignored). A user with an unknown name takes as long to answer as a real one, so names cannot be probed by timing. After repeated failures a name is locked out for 15 minutes. The login message is the same for a wrong name and a wrong password.
- Tokens last 12 hours and are held in the server's memory, so a restart signs everyone out. The extension keeps its token in `chrome.storage.local`, not `sync`, so it is not copied to other devices.
- The setup page and the settings never show or log the password.
- Connections to the server use whatever scheme the configured address has. **Use HTTPS for anything but localhost**: over HTTP, a network attacker can read the token and the model files.

### The model files

The extension downloads 0.4 to 2.4 GB from the server and runs it. A server that is compromised could serve a different model, which could not send data anywhere (a model file cannot) but could mislabel clauses. The manifest lists a SHA-256 for every file, and WebLLM verifies the kernel file (`.wasm`) against it and refuses to load on a mismatch. The weight shards are **not** verified one by one in the browser. Because the manifest comes from the same server, this catches a mismatched or corrupted kernel, not a malicious operator. Pinning the manifest hash somewhere else, or verifying the shards, would be the next step.

### Abuse of the server

- **Summaries** call a paid model: public, but limited per client address (20 an hour) and across everyone (500 an hour), and cached by content. Without a key configured the endpoint answers "unavailable".
- **Model downloads** are large: served with Range, ETag and long-lived cache headers so repeat and resumed downloads are cheap; put a CDN in front for real traffic.
- **Cross-origin calls.** Reads are open to any website (the data is public). Writes answer only extension origins and an optional allow-list, so a web page cannot make a user's browser upload for them.
- **The server never fetches an address a client gives it**, so there is no request forgery from it. The only outbound request is to the language-model endpoint the operator configured.
- **Behind a proxy**, set `PPG_TRUST_PROXY=1` only if the proxy sets `X-Forwarded-For`. With it off behind a proxy, every client shares the proxy's address in the rate limiter; with it on and no such proxy, clients could choose their own address and dodge the limit.

### The extension's own reach

The extension asks for `<all_urls>` host access, `tabs`, `storage` and `offscreen`, because it has to read the terms of any site the user chooses and warn about forms on any page. The content script is small (about 29 KB), does nothing with page text unless asked, and has a size budget checked by a test. The extension's pages use a content-security policy that allows only its own scripts (plus WebAssembly, which the model runtime needs).

## What this project does not defend against

- A user who is tricked into sharing, signing in on a fake setup page, or installing a modified extension.
- A contributor who uploads misleading results (see above).
- A clean result being read as "safe". It means no clause of the eight kinds was found.
- A server operator reading the server's own logs or database: the results are public anyway, and request logs hold network addresses.
- Anything outside terms of service in English.
- A page that fakes the interface: the in-page banner lives in an open shadow root, so page script can read it and can remove it. It cannot press Report or Share for the user, but it can hide the warning.
- The fee rules are patterns: a clause worded in a way nobody wrote a pattern for is missed.

## Data kept

| Where | What | How long |
|---|---|---|
| Server database | shared results (address, text hash, model, flagged sentences, counts, uploader name), cached summaries | 30 days, deleted daily |
| Server memory | tokens, sign-in failure counts, rate-limit counters, per hour or per 12 hours | until restart |
| Server logs | start-up, errors, and the reason a summary request failed | operator's choice |
| Browser | preferences, token, saved results (30 days, at most 50), per-tab state (until the tab closes), the model files | until removed in settings or uninstall |
