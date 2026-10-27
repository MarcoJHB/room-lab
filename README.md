# Room Lab

A personal room visualizer. Upload a photo of a room, click furniture to remove it, upload photos of furniture you want to try, and see it in your space.

Everything is a static site, so it runs on GitHub Pages with no server.

## How it works

- **Click to select**: a small Segment Anything model (SlimSAM) runs in your browser and turns a click into an outline of that piece of furniture. It downloads once from Hugging Face on first use and is cached after that. If it can't load, clicks drop a red circle instead, which still works.
- **The editing itself** is done by Google's Gemini image model ("Nano Banana"), called directly from your browser with your own API key. Removals send the photo plus a copy with the selected objects painted red. Additions send the photo, a copy with numbered green markers, and your furniture photos.
- Every result becomes a new version. You can flip back to any version, compare before/after with the slider, retry for a different take, and download.

## Setup

1. Get a Gemini API key at <https://aistudio.google.com/apikey>. Image models usually need billing turned on for the key. Each edit costs a few cents (check Google's current pricing).
2. Put these files in a GitHub repo (`index.html`, `app.js`, `sam-worker.js`, `style.css`).
3. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch**, pick `main` and `/ (root)`. The site appears at `https://<your-username>.github.io/<repo-name>/` after a minute.
4. Open the site, paste your key in **Settings**. It's stored only in that browser's localStorage, never in the repo.

**Lock the key down (recommended):** in Google Cloud Console → APIs & Services → Credentials, edit the key and add an HTTP referrer restriction for `https://<your-username>.github.io/*`. Then even if it leaked, it would only work from your site.

GitHub Pages on a private repo needs a paid GitHub plan. A public repo is fine here since there's no secret in the code.

## Using it

**Remove**
- Click a piece of furniture. It gets an outline.
- Click it again to unselect. `Shift`-click grows the last selection (e.g. to grab the other half of a sofa), `Alt`-click (or right-click) trims it. `Ctrl/Cmd+Z` drops the last selection.
- Hit **Remove**.

**Add**
- Upload or drag in photos of the furniture (product shots on a white background work best).
- Click the photo where each item goes, or drag a box to show roughly how big it should be.
- Rename items if the file name is unhelpful ("oak sideboard" helps the model).
- Hit **Add to room**.

Tips:
- Shoot the room wide, from a corner, in daylight.
- Do removal first, then additions on the cleaned-up version.
- Add one or two items at a time; results get worse with five at once.
- If a result is off, **Try again** reruns the same request. Notes like "the rug stays" or "the lamp sits on the side table" help.

## Local testing

The worker is an ES module, so open it through a local server rather than double-clicking the file:

```
python3 -m http.server 8000
```

then visit <http://localhost:8000>.

## Models

Pick in Settings:
- `gemini-2.5-flash-image`: cheapest and fast (default)
- `gemini-3.1-flash-image`
- `gemini-3-pro-image-preview`: best quality, slower and pricier
- or type any other image-capable Gemini model name
