# Design System

## Direction

Guided Workforce. Use supportive workflow language, a compact metric strip,
sticky mobile capture action, familiar navigation, and restrained operational
density.

## Color

- Brand mist: `#BBBFBF`
- Brand steel: `#878787`
- Brand teal: `#05AD98`
- Brand white: `#FFFFFF`
- Strong ink: `#162625`
- Default ink: `#263735`
- Muted ink: `#4D5E5B`
- Subtle surface: `#F5F7F7`
- Muted surface: `#E9EEEE`
- Primary tint: `#E4F7F4`

Teal is reserved for primary actions, selection, focus, progress, and success.
Statuses always include text or an icon. Do not introduce additional hue
families.

## Typography

Use `"Segoe UI Variable", "Segoe UI", "Noto Sans", system-ui, sans-serif`.
Use a fixed product scale from `0.75rem` to `1.5rem`, body text at `1rem`, and
tabular numerals for data.

## Layout

Use a 4px spacing scale, 8px maximum card radius, borders for ordinary
separation, and shadows only for overlays. Desktop admin and vendor routes use a
persistent side navigation. Tablet uses a drawer. Pump remains a focused
single-column workflow with a sticky phone action.

## Components

Use one shared vocabulary for shells, navigation, buttons, fields, metric
strips, status badges, tables, date ranges, calendars, evidence panels, empty
states, and feedback. Use `@lucide/svelte` as the only icon source.

## Motion

Use 120 to 200ms feedback transitions and up to 250ms for drawers. Motion
communicates state only. Respect `prefers-reduced-motion`.
