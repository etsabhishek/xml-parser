# Survey XML Inspector
Browser-based Decipher XML QA workspace.

## Run locally
```bash
npm install
npm run dev
```

Upload/paste XML, run the initial validation rules, inspect findings, download the source XML, and export a consolidated XLSX workbook with Summary, All Checks, Errors, Warnings, and XML Source sheets.

XML processing and Excel generation are performed locally in the browser. The current rule engine is an initial implementation, not a verified 1:1 port of XML Check v10.1.xlsm. Complete VBA auditing and golden-file comparisons are required before production sign-off.
