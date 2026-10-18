---
# Any-request task: exercises deal's custom request.ask[] fields (price, earliest date, ...) instead of
# the catering default. The mock fleet is catering-only, so this task is for LIVE runs.
#
# Before a live run, the operator fills in:
#   contacts       real plumbers who agreed to be contacted (name + email and/or E.164 phone), `;`-separated
#   expected_best  the business that actually gives the cheapest complete estimate (check the deal board
#                  after the run, or agree it with the plumbers beforehand)
# While expected_best is a <placeholder>, runs are recorded with `passed` empty (not judged).
expected_best: <cheapest plumber - fill in for live runs>
contacts: <Plumber A (email or +1 phone)>; <Plumber B (email or +1 phone)>
---
My kitchen sink is leaking from under the basin (the drain trap or the supply line, I'm not sure). I'm in San Francisco.
Get estimates from these plumbers:
{{contacts}}

Ask each one for: the estimated total price for the repair, their earliest visit date, whether they are licensed and insured, and any deposit or call-out fee.
Don't book or pay anything. When you have the answers, tell me which plumber has the cheapest estimate and give its estimate, earliest visit date and deposit.
