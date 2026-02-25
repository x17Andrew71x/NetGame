# CLAUDE.md

## Project Context

This is a hackathon project. A small team is building something quick and fun in a single session. There is no production environment, no CI/CD, no deployment pipeline. This code will never go to production. Speed and fun are all that matter.

This is a simple single-page web app. The entire app executes client-side. State is handled directly in the browser using localStorage. The developer may depart from this but will likely keep it to a simple pattern like this.

## How to Work on This Project

- **Bias heavily toward speed over polish.** Skip best practices that slow things down — no tests, no prop-types, no elaborate error handling, no accessibility passes, no TypeScript. Just make it work.
- **Keep things simple.** One component in App.jsx is fine. If the file gets big, that's okay. Don't refactor into multiple components unless it's actually making things easier or the user directs separate components so that two devs can work on different parts of the game. 
- **Don't over-engineer.** No state management libraries, no routing, no build optimizations. useState and useEffect are plenty.
- **If something is proving difficult or complex to implement, say so.** Suggest a simpler alternative. For example: "That physics simulation would take a while — want me to do a simpler version where things just bounce off walls?" The operator will often take the easier route.
- **Do not create README, CHANGELOG, or any other documentation files** unless specifically requested by the operator.

## Design Documents

Any design documents, references, or mockups for this project will be in the `/design` folder.

## Tech Setup

- Vite + React
- Dev server runs with `npm run dev` (exposes to network so teammates can view)
- All game/app logic lives in `src/App.jsx`
- Styling lives in `src/App.css`

## Style

- No linter, no formatter configured. Don't worry about code style.
- CSS are preferred over inline styles so that users can raipdly adjust styles at the end of the build. 
- `console.log` for debugging is encouraged.