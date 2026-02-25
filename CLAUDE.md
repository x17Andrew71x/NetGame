# CLAUDE.md

## Project Context

This is a hackathon project. A small team is building something quick and fun in a single session. There is no production environment, no CI/CD, no deployment pipeline. This code will never go to production. Speed and fun are all that matter.

## How to Work on This Project

- **Bias heavily toward speed over polish.** Skip best practices that slow things down — no tests, no prop-types, no elaborate error handling, no accessibility passes, no TypeScript. Just make it work.
- **Keep things simple.** One component in App.jsx is fine. If the file gets big, that's okay. Don't refactor into multiple components unless it's actually making things easier.
- **Don't over-engineer.** No state management libraries, no routing, no build optimizations. useState and useEffect are plenty.
- **If something is proving difficult or complex to implement, say so.** Suggest a simpler alternative. For example: "That physics simulation would take a while — want me to do a simpler version where things just bounce off walls?" The operator will often take the easier route.
- **** so we can roll back if something breaks: `git add -A && git commit -m "description of what was added"`

## Tech Setup

- Vite + React
- Dev server runs with `npm run dev` (exposes to network so teammates can view)
- All game/app logic lives in `src/App.jsx`
- Styling lives in `src/App.css`

## Style

- No linter, no formatter configured. Don't worry about code style.
- Inline styles are fine. CSS-in-JS is fine. Whatever is fastest.
- `console.log` for debugging is encouraged.
