# Narration

Three narrators. Each `###` block is one scene; every non-empty line under it is one spoken sentence (one audio clip), in order.
`voice.py` reads this file, so keep the shape: `### <scene id> · <narrator A|B|C> · <title>`.

Numbers come from the team's survey (31 responses, `video/data/survey.json`, made by `stats.ts`) and from this repository's tests.
Lines marked `(verify)` state something about the outside world that the team should check before publishing.

Revision 2: the first cut repeated itself (the threats were introduced in one scene and explained in another, the share card was shown
twice, and scenes were padded to reach seven minutes). Each idea is now said and shown once.

### s01 · A · Title
Every day, we click Accept on rules we have never read.
This is Privacy and Permission Guardian: a browser extension that reads them for you, and warns you before a website takes more than it should.

### s02 · A · The hidden cost
We asked thirty-one people how they deal with terms of service. Only one reads them in full.
Nine in ten say they are too long, and more than half feel they have no choice but to click Accept anyway.
So what is hiding in there? Clauses that let a company close your account without telling you, terms that change whenever it likes, and money: renewals that happen by themselves, fees for leaving, refunds that never come.
In 2024 the United States Federal Trade Commission sued Adobe, alleging that it hid early termination fees from its subscribers. (verify)
Most of us accept all of this, unread, every day.

### s03 · B · Reading the terms
Here is how Guardian answers the first problem. Setup says it plainly: an offline model runs completely inside your browser, and the text of the terms never leaves your computer.
Now we open a made-up device maker, Pomme, and press the toolbar button.
The model reads the terms sentence by sentence. Every tick on the strip is one sentence, and the coloured ones are clauses that tend to work against you.
The colours group them by what they do: your rights, liability, their control, consent, and money.
Above them, a short summary in plain English with a risk level, and under each point the exact sentence from the terms, so you can check the model's work.
Mandatory arbitration. An account that can be closed without notice. A plan that renews by itself, and a fee if you leave early.
One click shows that the same clauses appear on other sites too.
The model was trained on thousands of labelled clauses and tested on two thousand it had never seen. It is not perfect, and a clean result is never a guarantee.

### s04 · B · Real sites, and why not a chatbot
It works on real websites too: this is GitHub's terms, 358 sentences, read on this laptop in {{github_seconds}} seconds.
Paste the same text into a chatbot and it goes to somebody else's servers, and the answer depends on how you ask. Guardian stays in your browser, and uses the same tested method every time.

### s05 · B · Phishing and missing terms
The second problem is phishing. Fake sites copy a famous logo, fake forms send your password to an attacker, and some pages even block the developer tools.
This sign-in looks familiar, and nothing in its address names a brand. But its icon is borrowed from a well-known service, and the form sends your password to a different website.
Guardian compares the icon with a table of known brands, checks where the form posts, and warns you before you type: critical risk.
A genuine shop asking for a card number gets a caution instead. Be sure of who you are paying.
And this sign-up wants your card and publishes no terms at all. Guardian says so, lets the model read the fine print on the page, and you can report the site with one click.
The form warnings run on your own computer and need no model, so they work from the moment you install it.

### s06 · C · The loop
Guardian also learns from the people who use it. When a signed-in contributor reads a public terms page, the extension asks: share this result?
Reading a page is not permission to share it. Nothing is sent until you press the button, and the card lists exactly what would be.
A personal-data check runs first, so a page that shows your own account is never shared.
Shared results are kept for thirty days and anyone can look them up, even without a graphics card: shared-results-only mode reads nothing on your computer and sends only the name of the site.
The next visitor gets the answer in under a second, with similar clauses from other sites beside it.

### s07 · C · What comes next
Next, we want to bring Guardian to mobile, and grow the database so it can handle longer, more complex terms.
Privacy and Permission Guardian. Read less. Know more.
