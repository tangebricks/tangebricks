// The only place the live H12 test reaches the network from: a plain request to the deployed address, with a time limit. It is
// kept here, outside the test that mounts the widget, so that test contains no network code at all (the "no glue code" scan
// reads it). It is not the widget's path: the widget reaches the server only through the credit-wallet brick's own client.
export const overTheNetwork = (request: Request, timeoutMs = 30_000): Promise<Response> => fetch(new Request(request, { signal: AbortSignal.timeout(timeoutMs) }));
