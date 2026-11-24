/**
 * The verified identity of a request, set once by the workspace middleware after it checked membership. Handlers take
 * the workspace from here and never from the request body or query. The object is frozen, so nothing after the
 * middleware can point it at another workspace.
 */
export interface RequestContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: string;
}
