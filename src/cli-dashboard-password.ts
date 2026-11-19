import { dashboardToken } from './dashboard-auth.js';

try {
  console.log(dashboardToken());
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    console.error('The operator password is generated when the bot starts with live signing enabled. Paper mode opens directly.');
  } else {
    console.error(error instanceof Error ? error.message : 'Unable to read the dashboard password');
  }
  process.exitCode = 1;
}
