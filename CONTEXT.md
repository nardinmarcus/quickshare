# QuickShare Sharing Context

QuickShare manages published content shares and the management concepts used to organize them.

## Language

**Share**:
A published content item that can be opened through its generated address.
_Avoid_: Link, page

**Favorite Share**:
A Share collectively marked in the management dashboard for later retrieval. Its favorite status is shared across all dashboard sessions, is a binary classification without time-ordering semantics, and remains independent of public expiration.
_Avoid_: Personal favorite, bookmarked link

**Management Time Zone**:
The shared civil-time frame for QuickShare management, fixed to Beijing time (UTC+8) for every administrator. It governs displayed times, edited date-times, calendar-day filters, and daily reporting boundaries without changing the underlying instant.
_Avoid_: Server local time, browser local time, database time

**Site Identity Icon**:
The coordinated visual identity representing QuickShare in browser tabs, saved shortcuts, installed apps, and link previews.
_Avoid_: Figma element, functional icon, interface icon
