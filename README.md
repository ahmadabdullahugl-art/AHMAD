# Broker ID Finder

Search by brokerage domain or company name against FMCSA's **Company Census File**, which is updated daily. Results show only the MC number, DOT number, and business phone, with FMCSA SAFER and TruckCodex lookup links.

Domain lookups scan the homepage and likely contact/about/carrier pages, then match any MC/DOT mentions and the detected company name to FMCSA. Each candidate is checked against the public SAFER snapshot for the same DOT/MC and broker authorization. The last 12 lookups are saved in browser-local storage and can be reopened or cleared in the app.

## Run locally

```sh
npm start
```

Open http://localhost:4173. The first lookup needs an internet connection so the server can read public company pages and DNS records.

FMCSA does not provide a domain field in this dataset, so domain searches read the website's published company name and then query FMCSA. Name matches can include similarly named businesses. Only active census entries with an MC docket are shown; confirm broker authority and phone details with the linked public sources.
