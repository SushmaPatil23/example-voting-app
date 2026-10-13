const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

async function retryWithBackoff(operation) {
  const maxAttempts = 5;
  const initialDelayMs = 500;
  const maxDelayMs = 4000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Attempt ${attempt}`);
      return await operation();
    } catch (error) {
      if (!error.retryable) {
        console.log("Permanent error. Stopping retries.");
        throw error;
      }

      if (attempt === maxAttempts) {
        console.log("Maximum attempts reached. Stopping retries.");
        throw error;
      }

      const delayMs = Math.min(
        initialDelayMs * 2 ** (attempt - 1),
        maxDelayMs
      );

      console.log(`${error.message}. Retrying in ${delayMs} ms.`);
      await sleep(delayMs);
    }
  }
}

// Simulate a dependency that fails three times, then recovers.
let calls = 0;

async function simulatedDatabaseConnection() {
  calls++;

  if (calls <= 3) {
    const error = new Error("Database temporarily unavailable");
    error.retryable = true;
    throw error;
  }

  return "Database connection successful";
}

retryWithBackoff(simulatedDatabaseConnection)
  .then(message => console.log(message))
  .catch(error => {
    console.error(`Operation failed: ${error.message}`);
    process.exitCode = 1;
  });