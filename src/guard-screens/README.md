# Guard screens (kept, not routed)

Check & Send, Approvals, History and the QR scanner of SolSentry Guard. This app ships
validation only, so these files are outside `app/` and no route reaches them. They still
compile and their logic is still covered by the tests. To bring one back, add a route file in
`app/` that renders it.
