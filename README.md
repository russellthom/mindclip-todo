# mindclip-todo

A tiny mobile-friendly to-do web app (plain HTML/CSS/JS, no build step) served by GitHub Pages.

**This repo contains no data.** The list is stored in a separate private repository and is
read/written in the browser via the GitHub Contents API with a fine-grained personal access
token that the user pastes in on first launch. The token is kept only in that device's
localStorage and can be removed with *Menu → Sign out / forget token*.

Token setup: https://github.com/settings/personal-access-tokens/new → Repository access:
*Only select repositories* (the data repo only) → Repository permissions → *Contents: Read and write*.

Features: Work / Personal / Waiting On tabs, tap to complete, tap to edit, add, delete,
Open/Done/All filter, search, sort by due date then priority, overdue flags, dark mode,
add-to-home-screen support, debounced auto-save with conflict merge (last edit wins per item).
