# Activity image sharing

Wildloop turns an activity into a branded social image instead of asking the athlete to crop a screenshot. The image always includes the activity title and type, athlete and completion date when available, a normalized route trace, distance, moving time, average pace, and elevation gain.

## Formats

The activity page offers three formats from the same source data:

- `square`: 1080 by 1080 pixels for feed posts
- `story`: 1080 by 1920 pixels for vertical stories
- `landscape`: 1200 by 630 pixels for link previews

The preview updates immediately when the athlete changes formats. **Share image** renders a full-resolution PNG and opens the operating system's native share sheet when file sharing is available. **Download PNG** always saves the image locally. Browsers without file-sharing support use the download behavior automatically.

## Implementation

Card composition comes from the browser-safe `ts-images/activity-card` export. Wildloop's integration is split into three layers:

- `resources/functions/activity-share.ts` maps Wildloop activity data, creates SVG previews, renders PNG files in a browser canvas, and handles native sharing or download.
- `resources/composables/useActivityShare.ts` owns the selected format, progress state, feedback message, and user actions.
- `resources/views/activity/[id].stx` presents the preview and controls.

This keeps DOM APIs out of STX templates and keeps the card renderer reusable by other activity clients.

## Route privacy

The card contains a normalized geometric trace, not latitude, longitude, map tiles, street names, or a coordinate reference. Source coordinates are converted into SVG drawing commands inside the card's route panel. The share action only runs after an explicit user click.

## Verification

`tests/unit/activity-share.test.ts` verifies metric mapping, route inclusion, social dimensions, and embeddable previews. The upstream `ts-images` suite verifies all presets, XML escaping, safe colors, invalid-point filtering, bounded route paths, download names, declarations, and the published package subpath.
