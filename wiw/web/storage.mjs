// Saved plans are keyed by repository and immutable source revision.
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('willitwasm', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('plans');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function requestPlan(mode, action) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('plans', mode);
      const request = action(tx.objectStore('plans'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || Error('Plan storage was interrupted'));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const getPlan = key => requestPlan('readonly', store => store.get(key));
export const savePlan = (key, plan) => requestPlan('readwrite', store => store.put(plan, key));
