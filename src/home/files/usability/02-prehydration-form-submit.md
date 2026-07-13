# 🔴 Auth forms silently no-op before React hydrates

Reproduced tonight with Playwright, but a human on a cold dev server (exactly
what every reload of this ship is) can hit it too: submit the signup form
before hydration finishes and the <form> does a NATIVE GET submit — URL becomes
/signup?, every field silently clears, no error, no account. The user's
password and invite code just vanish from the screen. (Second attempt after
hydration worked fine.)

Cold loads are slow here (dev SSR + on-demand transform after any main merge —
I measured needing ~5s before the handler was live), so this window is real.

Discussion: progressive-enhancement guard — e.g. disable the submit button
until hydrated, or give the form a real action that answers with "still
loading, try again", or SSR a hidden field the server rejects with a friendly
message. Same applies to the login form and probably every form in the ship.
