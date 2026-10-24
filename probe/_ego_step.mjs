
const t = await taskSpace("m0-probe");
const p = t.page("p1");
console.log(JSON.stringify({space: t.spaceId, href: await p.evaluate("location.href")}));
