# MyBudget v4.12.82 — Mobile UI refinement

- Mobile-only styling overrides; desktop styling/layout intentionally unchanged.
- Compact two-column KPI cards and better card sizing/spacing.
- Transactions render as stacked mobile rows instead of a wide horizontal table.
- Bills page has a Calendar/List view switch; the list is grouped by date and includes event action links.
- Larger mobile chart touch area; chart tooltips can be tapped and selected.
- Top navigation menu clearly labeled and opens the mobile More panel.
- Modal forms use iOS-safe input font sizes and improved scrolling/sticky modal heading.
- No financial calculations, storage format, or financial data model changes intended.


## v4.12.83 Mobile chart interaction correction
- Added top-right multi-month selectors to Dashboard 12-Month Cash Position, Forecasts Income vs Outflow and Projected Savings, and Annual Dashboard Quarterly/Monthly Cash-Flow Comparison.
- Month selectors filter the chart data; Clear and All controls included.
- Added mobile horizontal overflow support for chart areas and vertical scrolling for Debt Accounts chart.
- Preserved desktop behavior and financial calculations.


## v4.12.84 Mobile regression fixes
- Month selector options remain fixed to all 12 months while chart data filters, allowing multiple selections without options disappearing.
- Month selector stays open after checkbox changes and is aligned to the card header's right edge.
- Fixed mobile More-menu outside-click handling when tapping the icon/text inside the button; enlarged touch targets.
- Restored visible weekday headers and tightened mobile calendar navigation layout.
- Enabled horizontal scrolling for Cash-flow Forecast, Annual Quarterly Cash Flow, and Monthly Annual Summary tables; corrected Debt Accounts chart vertical scroll.
- Improved mobile card/header wrapping and table scrolling. No financial calculations or data structures changed.


## v4.12.85 — Mobile presentation polish
- Mobile chart card headings and descriptions wrap without being hidden behind the month selector.
- Cash-flow forecast period selector is constrained and its description wraps.
- Debt accounts table has a dedicated horizontal scroll area on mobile.
- Chart detail tooltip selection now toggles off when tapping the same data point again.
