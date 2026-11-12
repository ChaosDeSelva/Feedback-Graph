# Architecture chat, sync service

Priya: Before we start, the session cache question.
Priya: We won't use Redis for the session cache; the in-process store is enough at our scale.
Tobin: I think the in-process store will fall over under load.
Tobin: The build agents run Node 22.
Priya: The ledger client retries 5 times before it gives up.
Tobin: Can we get load numbers for the session store before we commit either way?
