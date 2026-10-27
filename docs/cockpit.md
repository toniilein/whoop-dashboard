# Cockpit: build your own dashboard

The cockpit is a dashboard you put together yourself. Pick the cards you care about,
arrange them in a grid and group them into sections. Save several layouts, for
example a quick morning check-in and a detailed training view.

![A cockpit called "Morning check-in" with sections for today, warning signs and trends](screenshots/cockpit.png)

## Getting started

1. Switch from **Dashboard** to **Cockpit** in the bar above the charts.
2. Click **Suggested layout** for a starting set, or drag cards in from the list on
   the left.
3. Click **Done** when you're happy. **Edit layout** brings the list and the card
   controls back.

The cockpit uses the same date range and theme as the dashboard.

![Edit mode: the list of every KPI on the left, and cards with move, resize and remove buttons](screenshots/cockpit-edit.png)

## Building a layout

The list on the left holds everything the dashboard can draw: the three overview
cards, about 40 tiles, 30 charts including the calendar heatmaps, and the Healthspan
table. Heatmaps start at full width. Type in the search box to find
one quickly.

- **Add a card** by dragging it into the grid, or with its **+** button in the list.
- **Reorder** by dragging a card to a new place.
- **Remove a card** by dragging it back onto the list, or with its remove button.
- **Change the width** with the width button on each card. Each click steps to the
  next size that card supports.

Each card also has buttons to move it, resize it and remove it. So the cockpit works
with a keyboard and on touch screens, where drag and drop isn't available.

## Sections

Add a **Section divider** from the Layout group at the top of the list, as often as
you like. A divider spans the full width. Type into it to rename it, and drag it by
its grip or use its buttons to move it. Outside edit mode it becomes a section
heading.

## Several cockpits

The tabs above the cockpit switch between your saved layouts.

- **+ New** starts an empty one.
- In edit mode, type into the title to rename the current cockpit.
- **Duplicate** copies the current cockpit, which is handy for variations. It
  appears in edit mode.
- **Delete** removes the current cockpit, after asking. It appears in edit mode,
  and you always keep at least one.
- **Clear** removes every card from the current cockpit, after asking.

## Where layouts are saved

Cockpits are saved in your browser only, in `localStorage`. Another browser or
computer starts with one empty cockpit. Clearing your browser's site data for
`localhost:3000` removes them.

## Ideas for layouts

- **Morning check-in:** recovery, sleep and strain cards, then HRV versus baseline,
  the illness warning and the training load ratio as warning signs.
- **Training:** strain, heart-rate zone time, strength activity, training load ratio,
  workout time and calories by sport.
- **Sleep focus:** hours versus need, sleep stages, bedtime and wake time, Sleep
  Regularity Index and chronotype.
