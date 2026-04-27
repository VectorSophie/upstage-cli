export async function fetchData(url) {
  // Simulates an async fetch with a small delay
  return new Promise((resolve) => {
    setTimeout(() => resolve({ url, data: [1, 2, 3] }), 10);
  });
}

export function parseConfig(raw) {
  if (typeof raw !== "string") throw new TypeError("config must be a string");
  return JSON.parse(raw);
}
