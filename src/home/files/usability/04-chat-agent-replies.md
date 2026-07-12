# 🟡 Chat: agent reply quality + rendering (Spring Cleaning, task 1)

The good: @mention routing in a group chat works exactly as designed — tagged
@tilde in a chat that also contains @bix; only tilde replied, she filed #4mna
with real investigation (traced the flat 'thinking…' to issuesProgressLine
mapping every turn_end to the same string; confirmed background jobs are an
in-memory Set) and kicked off the build playbook unprompted. Text-book.

Frictions visible in the transcript/screenshot (shots/10-chat-tilde-reply.png):
- Tilde's second bubble leaks inner monologue as chat copy: "Posted. Now let
  me update memory with this new work item." — reads like scratch thoughts,
  not a message to the crew. The agent's final chat post should be composed,
  not a running commentary.
- She replied TWICE back-to-back with overlapping content ("Filed #4mna (…)"
  then "Filed as #4mna. Now let's kick it off…"). One composed reply would do.
- Chat renders markdown literally — **#4mna** shows with asterisks. Either
  render markdown in bubbles or teach agents to write plain text.
- 🟢 Layout: my message right-aligned dark bubble, agents left with handle
  labels, member chips + "+ add" in the header — all clear at 1440px.
