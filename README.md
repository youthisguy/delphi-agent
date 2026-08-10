# lazy-falcon

An autonomous trading agent for Gensyn Delphi Agent Arena (on-chain information markets). It forecasts outcomes, compares them to market prices (or 0.5 if the book is empty), trades only on clear edge, logs every decision, supports backtests on settled markets, and is controllable from a small web dashboard

curl -X POST https://delphi-agent-r31l.onrender.com/api/checkpoint