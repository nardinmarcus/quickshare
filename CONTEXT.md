# QuickShare Sharing Context

QuickShare manages published content shares and the management concepts used to organize them.

## Language

**Share**:
A published content item that can be opened through its generated address.
_Avoid_: Link, page

**Markdown Theme Preset**:
A named, brand-inspired presentation choice for a Markdown Share. It changes the Share's visual treatment without changing its Markdown content or the QuickShare site shell, and does not claim to replicate an official brand interface.
_Avoid_: Site theme, brand replica, Markdown template

**Preset Visual Identity**:
The recognizable combination of typography, color, spacing, and signature rendered elements that distinguishes one Markdown Theme Preset from another. It remains recognizable across Theme Reading Baseline, adaptive appearance, and accessibility improvements without requiring pixel-identical output.
_Avoid_: Pixel snapshot, brand replica, immutable stylesheet

**Markdown Theme Catalog**:
The curated set of Markdown Theme Presets built into QuickShare and available to Share creators and administrators. Presets enter the Catalog through a QuickShare release rather than user-authored settings or CSS.
_Avoid_: Theme editor, custom CSS library, theme marketplace

**Preset Label**:
The user-facing Catalog name that combines a Markdown Theme Preset's brand inspiration with QuickShare's description of its visual direction. A Preset Label may change without changing the Preset's stable stored identifier.
_Avoid_: Official theme name, preset identifier, brand name alone

**Adaptive Theme Appearance**:
The light or dark presentation of a Markdown Theme Preset selected from each viewer's system preference. Appearance is a property of the Preset at viewing time, not a choice stored on the Share.
_Avoid_: Separate light theme, creator-locked appearance, Share appearance setting

**Theme Reading Baseline**:
The responsive readability and accessibility contract shared by every Markdown Theme Preset. A Preset may add its own recognizable visual treatment without changing this common reading behavior.
_Avoid_: Default theme, visual identity, identical component styling

**Theme Asset Boundary**:
The rule that Markdown Theme Presets express their identity with system font stacks and local styling without introducing theme-specific remote font or visual-asset requests.
_Avoid_: Brand font copy, theme CDN dependency, remote theme asset

**Theme Expression Boundary**:
The reading-first limit that keeps Markdown Theme Presets static and restrained while allowing recognizable color, typography, surfaces, and signature elements. Presets do not use continuous motion, particles, large decorative imagery, or intense glow as part of the reading experience.
_Avoid_: Immersive landing page, animated theme, decorative spectacle

**Theme Sampler**:
A compact preview beside the Markdown Theme Catalog control that immediately demonstrates the currently selected Preset through one fixed representative Markdown sample. The same single-preview interaction is available when creating or administratively editing a Markdown Share, while actual Share content remains the responsibility of the full Share preview.
_Avoid_: Theme gallery, theme card grid, full Share preview

**Creator Theme Preference**:
The most recently selected Markdown Theme Preset remembered by one browser for the next new Markdown Share. It does not change the Catalog fallback or override the Preset already stored on an existing Share.
_Avoid_: Site default theme, account preference, Share theme

**Favorite Share**:
A Share collectively marked in the management dashboard for later retrieval. Its favorite status is shared across all dashboard sessions, is a binary classification without time-ordering semantics, and remains independent of public expiration.
_Avoid_: Personal favorite, bookmarked link

**Management Time Zone**:
The shared civil-time frame for QuickShare management, fixed to Beijing time (UTC+8) for every administrator. It governs displayed times, edited date-times, calendar-day filters, and daily reporting boundaries without changing the underlying instant.
_Avoid_: Server local time, browser local time, database time

**Site Identity Icon**:
The coordinated visual identity representing QuickShare in browser tabs, saved shortcuts, installed apps, and link previews.
_Avoid_: Figma element, functional icon, interface icon
