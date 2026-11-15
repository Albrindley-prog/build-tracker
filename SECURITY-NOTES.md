# Security notes — build-tracker.co.uk

Last updated: 2026-11-15 (Videos page, privacy notice, analytics removed). Nothing here says the site is "secure". It lists what was
looked at, what was not, and what the owner still needs to do.

## 1. Videos page (`videos.html`, `videos/`) — added 2026-11-15

**What it is:** a static page (no forms, no log-in, no cookies, no database, no new scripts from
anywhere else) that plays 11 demo videos stored in the site's own `videos/` folder.

**Checked (by reading the code and the files):**
- No place where a visitor's input reaches the page: nothing reads the web address, cookies or
  storage. The only text put on screen by script uses `textContent`, never HTML. No `eval`.
- The video player's source comes from a fixed link in the page, on the same site.
- The only outside load is the Google Fonts stylesheet (same as the rest of the site).
- Every video and picture was scanned for names, e-mail addresses, file paths and photo (EXIF)
  data: none. The only tag is the encoder (`Lavf`/`libx264`). The videos have no sound track.
- Content review of all 10 videos (9 evenly spaced frames each) and the Stock Control video
  (frame by frame, earlier): only invented sample data (fictional businesses, `.test` /
  `example.com` e-mails, the fictional 07700 900 phone range). No PD Stevens / Stevens
  Bodyworks branding.
- A `security-review` pass over the commit: no findings.
- Tested in a real browser: all 11 videos play, seek and close; no broken images; no errors
  other than the site's existing missing-favicon 404.

**Not checked / known gaps:**
- Only 9 frames per video were looked at (10 videos), not every frame. A name or number that
  appears for a second between those frames could be missed. **Owner: watch each video once
  before telling customers about the page.**
- Customer-branded videos (PD Stevens, Stevens Bodyworks) are deliberately NOT on the site.
  Do not add them without the customer's written OK. The 12 Nov "own parts" Stock Control video
  shows PD Stevens' real parts and prices: never publish it.
- Videos are public files: anyone can download them at `/videos/<name>.mp4`, and once pushed
  they stay in git history even if deleted later. To remove one properly, the git history would
  have to be rewritten, and GitHub may keep cached copies.
- GitHub Pages doesn't allow custom response headers, so a Content-Security-Policy and similar
  headers can't be set on this site while it stays on GitHub Pages.
- No independent human security review has been done (not required for this change: no personal
  data, payments or children's data are handled by the page).

## 2. Website chat assistant (`assistant/`, `supabase/functions/ask-assistant/`) — live since 2026-11-06

Re-read on 2026-11-15 so these notes match the code. **This was published without notes; it has
had no independent review.**

**Checked:**
- The Gemini key is read from a Supabase secret (`GEMINI_API_KEY`). A search of the repo found
  no AI keys. (The Supabase "anon" key in many pages is public by design; what protects the data
  is the row-level-security rules on each table, which were NOT reviewed in this pass.)
- The chat panel never inserts the assistant's text as HTML.
- Limits in the function: 600 characters per question, last 10 messages kept, 1,500 output
  tokens, 15 questions per visitor per hour and 300 per day overall (defaults; can be changed
  with Supabase settings), origin allow-list
  (build-tracker.co.uk and localhost), on/off switch (`ASSISTANT_ENABLED`).
- The chat log table (`bt_assistant_chats`) has row-level security on with no public access.
  Visitors' addresses are stored only as a one-way scramble, not in plain text.
- The assistant has no tools and no access to customer data. The worst realistic failure is a
  wrong or off-topic answer (for example an out-of-date price from the fact sheet).

**Known gaps and risks:**
- The origin check only applies when the caller sends an `Origin` header, so a script (not a
  browser) can skip it. The hourly and daily limits still apply, which bounds cost, but someone
  could use up the day's 300 questions and make the chat say it "needs a rest".
- The function's "Verify JWT" setting only needs the public Supabase key, so it filters
  casual misuse; it is not a login.
- Visitors can type personal details into the chat. Their questions and the answers are saved
  (the panel says so). The "delete chats older than 90 days" command in
  `migration-assistant.sql` is **manual**, not scheduled.
- Questions are sent to Google (Gemini). Which data terms apply depends on the Google plan
  (free or billed). This was not re-verified today.
- How the visitor's address is read for the limits (`clientIp`) was not examined in depth.

## 3. Owner actions (things only the owner can do)

1. **Privacy notice.** `privacy.html` is drafted (branch `feature/privacy-notice`, linked from
   the home page and Videos page footers and from the chat panel). Read it, confirm the items
   in section 3a, then it can be published. Until it is published the site still has no
   privacy notice (UK GDPR / Data Protection Act 2018 duty, because chats are saved).
2. **Chat log retention.** Decide how long to keep chats and run the delete command regularly
   (Supabase → SQL Editor), or ask for it to be scheduled.
3. **Notepad copy of the Gemini key.** If you saved the key in a Notepad file, check where it
   is (especially if inside OneDrive, which syncs to the cloud) and delete it. If it was ever
   pasted into chat, e-mail or shared, rotate it (make a new key in Google AI Studio, update
   the Supabase secret, delete the old key).
4. **Google billing/limits.** Set a spending cap or alert in Google Cloud so a runaway cost is
   caught early.
5. **Watch the videos** (see section 1) and tell me if any frame shows something private.
6. **Optional:** add a favicon (the site currently returns 404 for `/favicon.ico`).

### 3a. Things to confirm before the privacy notice goes live

The notice makes promises, so each one must be true. Please check:
- **Chats kept up to 90 days.** True only if the delete command in `migration-assistant.sql`
  is run (it is manual today). Run it regularly, or ask me to set up automatic deletion.
- **Enquiries kept up to 2 years; payment records about 6 years.** My suggested periods. Check
  the 6 years with your accountant.
- **"Close my account and we delete it."** Confirm you are able and willing to do that.
- **"We store your customers' data for you and use it for nothing of our own."** Confirm.
- **Data protection fee / ICO registration.** Most businesses that handle personal data must pay
  the ICO's annual fee unless exempt. Check at ico.org.uk ("Do I need to pay?"). The notice
  does not quote a registration number.
- **Business address.** The notice says "Cheshire East, UK" only. If you sell to the public,
  UK e-commerce rules may also want a full geographic address on the site. Check.
- **Overseas providers.** The notice says safeguards apply when information goes outside the UK.
  I did not verify each provider's current legal mechanism.
- **Chat browser ID.** The chat stores a random ID in the visitor's browser to group
  questions. It is not strictly necessary (the scrambled-address limit does the real work), so
  it arguably needs consent. Simplest fix: remove it. Say if you want that done.
- **The contact form and "send me the guide" box** only open the visitor's own email program,
  but the pop-ups say "Message sent successfully!" and "we've sent the guide straight to you!".
  Neither is true until the visitor presses send. Not a privacy problem, but misleading.

### 3b. Analytics removed (2026-11-15)

The home page loaded Google Analytics (it sets cookies) with no consent prompt, which UK
cookie rules (PECR) require. The owner chose to remove it. It was removed from `index.html` on
branch `feature/privacy-notice` (not live until that branch is published). A search of every
page found no other analytics or tracking code. If statistics are wanted again later, use a
cookie-free counter or add a consent banner first.

## 4. Not reviewed in this pass

- The unpublished `feature/build-tracker-dvla-reg-lookup` branch (DVLA lookup function).
- Row-level-security rules for every table behind the apps.
- Payments (the Stripe checkout and price lock) — payment features need an independent human
  review before relying on them.
