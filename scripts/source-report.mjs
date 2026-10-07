// Usage: node scripts/source-report.mjs /checkout --commit <HEAD SHA>
// Optional local related indexes: --meaning-index /checkout --meaning-commit <SHA>
// and --model-index /checkout --model-commit <SHA>; --check-index checks the
// committed Directory index's source projection, never its database metadata.
import { sourceContractReport, sourceReportArguments, sourceReportUsage, reportExitCode } from './lib/source-report.mjs';
let report;
let options;
try { options = sourceReportArguments(process.argv.slice(2)); }
catch { report = sourceReportUsage(); }
if (options) {
  try { report = sourceContractReport(options); }
  catch {
    report = sourceReportUsage();
    report.checks = { report: { outcome: 'unrunnable' } };
    report.findings[0] = { code: 'report-unrunnable', severity: 'error', path: 'input', field: '', outcome: 'unrunnable', check: 'report' };
  }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = reportExitCode(report);
