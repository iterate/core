/** Who is asking: the client's name and, independently of the name the client supplies, the domain
 *  its metadata came from. */
export function ClientHeading({
  clientName,
  clientDomain,
}: {
  clientName: string;
  clientDomain?: string;
}) {
  return (
    <header>
      <h1 className="wrap-anywhere">{clientName} wants to access your account</h1>
      {clientDomain ? <p className="wrap-anywhere text-muted-foreground">{clientDomain}</p> : null}
    </header>
  );
}
