# Golden Lines Mobile Sync

This is the copied mobile/PWA version of the original Golden Lines learning app. The original project at `D:\生活软件\My English learning` is left unchanged.

## What changed

- The app is still a Vite + React PWA.
- App data is saved in the browser first, using IndexedDB with a localStorage fallback.
- On first launch, the app bootstraps from `public/vocab-store.json`, which was copied from the original `data/vocab-store.json`.
- GitHub Gist can be used as the shared cloud JSON file, so phone and computer can sync without a private server.
- AI annotation and simple example generation now call the configured AI API directly from the browser. If the provider blocks browser/CORS requests, use the desktop/local workflow for that provider.

## Run locally

This machine does not expose `npm` in PowerShell, so dependencies were copied from the original project. If your own terminal has Node/npm, normal commands work:

```powershell
npm install
npm run dev
npm test
npm run build
```

The copied `package.json` uses:

```text
vite --host 0.0.0.0
vite preview --host 0.0.0.0
```

That lets a phone on the same Wi-Fi open the app from your computer's LAN IP, for example:

```text
http://192.168.x.x:5173
```

## GitHub Gist sync setup

1. Create a GitHub token with Gist permission.
2. Open Settings in the app.
3. Fill in `GitHub Token`.
4. Either paste an existing `Gist ID`, or leave it empty and click `Push to cloud` to create a private Gist.
5. Keep the remote file name as `vocab-store.json` unless you need a different file.
6. On the phone, open the same PWA, enter the same token and Gist ID, then click `Pull from cloud`.

The token is stored only in that browser's local storage. It is not written into source files, build output, or the Gist data file.

## Sync behavior

- `Push to cloud` uploads the local browser data.
- `Pull from cloud` replaces the local browser data with the Gist data.
- `Overwrite cloud` forces the Gist to match local data.
- `Auto push local changes after saving` attempts a push after edits and reviews, and also loads newer cloud data when the app starts.
- If remote data is newer than local data, normal push refuses to overwrite it. Pull first or use overwrite intentionally.

## Static deployment

After `npm run build`, deploy `dist/` to any static host such as GitHub Pages, Netlify, Vercel, or another static file server. No private backend is needed.

## Phone speech notes

Mobile browsers may require a user tap before speech can start. Open Settings and press `Test speech` once after launching the app. Browser speech depends on the phone/browser voice engine; Chrome/Edge on Android and Safari on iOS are the safest choices.

## Desktop visibility

The original desktop project still reads its own `data/vocab-store.json` and is intentionally unchanged. To see phone changes on a computer, open this copied PWA version on the computer and click `Pull from cloud`, or enable auto sync after configuring the same Gist.

## Automatic AI then cloud flow

For new words, new quote captures, imported JSON data, article-selected words, and the manual `Update AI annotations` action, the app now follows this order:

1. Save the new data locally in the browser.
2. Complete AI annotations for the affected words.
3. Save the annotated data locally again.
4. Push the completed store to GitHub Gist when auto sync is enabled.

To make this automatic across phone and computer, both devices must use the same Gist ID and `Auto push local changes after saving` must be enabled in Settings. If AI fails, the local save still remains, and the status message shows what failed.

## Auto pull on page refresh

When `GitHub Token` and `Gist ID` are configured, the app checks GitHub Gist on page load/refresh and automatically pulls the cloud store if it is newer than the local browser copy. `Auto push local changes after saving` only controls uploads; downloads on refresh do not require that checkbox.

## Mobile layout and deletion

On phones, navigation moves to a fixed bottom tab bar with larger text and touch targets. The vocabulary library now includes `删除单词`; deleting a word removes the word card, its review history, and quote links, then follows the normal save/sync behavior.

## Use from any network

Gist is used for data sync only. It is not the right place to host the app itself. To use the app from any Wi-Fi or mobile network, deploy the built `dist/` folder to a free static host such as GitHub Pages, Netlify, or Vercel.

This build now uses relative asset paths, so it can work under a GitHub Pages project URL such as:

```text
https://your-name.github.io/golden-lines-mobile-sync/
```

A ready-to-upload package was created at:

```text
D:\生活软件\golden-lines-mobile-sync-dist.zip
```

Shortest GitHub Pages path:

1. Create a new GitHub repository, for example `golden-lines-mobile-sync`.
2. Upload the contents of `dist/` to that repository.
3. In repository Settings -> Pages, publish from the branch root.
4. Open the Pages URL on both phone and computer.
5. In the app Settings, enter the same GitHub Token and Gist ID on both devices.

The app URL becomes independent of Wi-Fi. Gist keeps the vocabulary data synchronized.

## AI lookup

The app includes an `AI查词` page. Enter one word, press `AI翻译`, and the configured AI API returns phonetic spelling, part of speech, Chinese meanings, related senses, root-family words, notes, and examples. Press `添加至单词库` to add the previewed word as a vocabulary card; it then follows the normal local save and cloud sync flow.
