# 🟢 #4mna's stalled-vs-busy indicator verified live (shot 12)

The first Spring Cleaning feature is deployed and immediately useful: while
@bix's #jgdb build runs, the issue board shows BUILDING·1 with an amber hammer
icon and the live amber status line (🔧 bash cd …) — the "busy" state. The
board now communicates real activity rather than a flat 'thinking…'. Still to
observe in the wild: the blue "waiting on background job" state and the red
'⚠ stalled Nm' state (hopefully rare).

Addendum to doc 04: the inner-monologue leak in chat replies is agent-wide,
not a tilde quirk — @bix's second reply was "Now let me file the issue with
the build playbook, matching the pattern @tilde used." The chat-turn prompt
should tell agents their message is a composed post to the crew, not a
thinking stream. (Also his two messages rendered newest-monologue-last after
the filed-confirmation — mild ordering oddity, worth a look when fixing.)
