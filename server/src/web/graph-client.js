/* Le graphe des invitations : React (sans JSX) pour le panneau, d3 pour la disposition et le zoom. */
(function () {
  var h = React.createElement;
  var useState = React.useState, useEffect = React.useEffect, useMemo = React.useMemo, useRef = React.useRef;
  var INK = "#111111", CREAM = "#F5F0E6", LINE = "#d9d2c3", MUT = "#9a958c";
  var DEMO = /[?&]demo=1/.test(location.search);

  function quotaFor(q, d) { return q[Math.min(Math.max(0, d), q.length - 1)] || 0; }
  function day(s) { return s ? new Date(s).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) : "-"; }

  /** Un arbre inventé, pour voir la page avant d'avoir du monde (?demo=1). */
  function demoData() {
    var seed = 11;
    function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
    var quotas = [5, 3, 1, 0], users = [], n = 0;
    var names = ["Lina", "Yanis", "Sarah", "Hugo", "Inès", "Adam", "Chloé", "Nolan", "Jade", "Rayan", "Léa", "Ilyes", "Manon", "Samy", "Emma", "Bilal", "Zoé", "Tom", "Nora", "Malik", "Camille", "Ethan", "Maya", "Noah"];
    function mk(parent, depth, campaign) {
      n++;
      var first = names[(n * 5) % names.length];
      var active = rnd() < 0.78 - depth * 0.14;
      var q = quotaFor(quotas, depth);
      var used = rnd() < 0.2 ? 0 : Math.round(q * (0.35 + rnd() * 0.65));
      var u = {
        id: "u" + n, handle: "+33 6 12 " + String(10 + (n * 37) % 89) + " " + String(10 + (n * 53) % 89) + " " + String(10 + (n * 71) % 89),
        name: first + " " + String.fromCharCode(65 + (n * 7) % 26) + ".", email: first.toLowerCase().replace(/[^a-z]/g, "") + n + "@gmail.com",
        status: "active", invited_by: parent, invite_depth: depth, attribution_code: campaign || null,
        created_at: new Date(Date.now() - (28 - depth * 6 - rnd() * 4) * 864e5).toISOString(),
        msgs: Math.round(rnd() * 140 * (active ? 1 : 0.15)), msgs7: active ? Math.round(1 + rnd() * 30) : 0, jobs: Math.round(rnd() * 14),
        last_in: active ? new Date(Date.now() - rnd() * 5 * 864e5).toISOString() : null, invite_code: q ? "c" + n : null, used: q ? used : 0, uses_left: q ? q - used : 0,
      };
      users.push(u);
      for (var i = 0; i < (q ? used : 0); i++) mk(u.id, depth + 1);
    }
    for (var r = 0; r < 4; r++) mk(null, 0);
    for (var c = 0; c < 2; c++) mk(null, 0, "mell");
    return { quotas: quotas, users: users, campaigns: [{ code: "mell", label: "lien ouvert", used: 2, uses_left: 998 }] };
  }

  /** L'arbre : Mell à la racine, les campagnes, puis chaque personne sous celle qui l'a invitée. */
  function build(data) {
    var byId = {}, root = { id: "root", kind: "root", label: "Mell", children: [] };
    byId.root = root;
    (data.campaigns || []).forEach(function (c) {
      var node = { id: "code:" + c.code, kind: "campaign", label: c.code + (c.label ? " · " + c.label : ""), c: c, children: [] };
      byId[node.id] = node;
      root.children.push(node);
    });
    data.users.forEach(function (u) { byId[u.id] = { id: u.id, kind: "user", label: u.name || u.handle, u: u, children: [] }; });
    data.users.forEach(function (u) {
      var parent = (u.invited_by && byId[u.invited_by]) || (u.attribution_code && byId["code:" + u.attribution_code]) || root;
      byId[u.id].parent = parent;
      parent.children.push(byId[u.id]);
    });
    root.children = root.children.filter(function (c) { return c.kind !== "campaign" || c.children.length; });
    function walk(node) {
      var desc = 0, act = 0;
      node.children.forEach(function (c) {
        walk(c);
        desc += 1 + c.desc;
        act += (c.u && c.u.msgs7 > 0 ? 1 : 0) + c.activeDesc;
      });
      node.desc = desc;
      node.activeDesc = act;
      if (node.u) {
        node.quota = node.u.invite_code ? (node.u.used || 0) + (node.u.uses_left || 0) : quotaFor(data.quotas, node.u.invite_depth);
        node.used = node.children.length;
        node.yield = node.used ? act / node.used : 0;
        node.active = node.u.msgs7 > 0;
      }
    }
    walk(root);
    return { root: root, byId: byId };
  }

  function radius(n) { return n.kind === "root" ? 16 : 6 + 2.4 * Math.sqrt(n.desc || 0); }

  function Graph(props) {
    var svgRef = useRef(null), gRef = useRef(null);
    var layout = useMemo(function () {
      var hroot = d3.hierarchy(props.tree.root, function (d) { return d.children; });
      d3.tree().nodeSize([34, 230]).separation(function (a, b) { return a.parent === b.parent ? 1 : 1.35; })(hroot);
      return hroot;
    }, [props.tree]);

    useEffect(function () {
      var svg = d3.select(svgRef.current), g = d3.select(gRef.current);
      var zoom = d3.zoom().scaleExtent([0.12, 3]).on("zoom", function (e) { g.attr("transform", e.transform); });
      svg.call(zoom).on("dblclick.zoom", null);
      var hgt = svgRef.current.clientHeight, narrow = svgRef.current.clientWidth < 600;
      svg.call(zoom.transform, d3.zoomIdentity.translate(narrow ? 40 : 90, hgt / 2).scale(narrow ? 0.5 : 0.85));
      props.zoomRef.current = function (node) {
        var d = layout.descendants().find(function (x) { return x.data === node; });
        if (!d) return;
        var w = svgRef.current.clientWidth, hh = svgRef.current.clientHeight;
        svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(w / 2 - d.y * 1.1, hh / 2 - d.x * 1.1).scale(1.1));
      };
    }, [layout]);

    var sel = props.selected;
    var lit = useMemo(function () {
      var ids = {};
      if (!sel) return null;
      (function down(n) { ids[n.id] = 1; n.children.forEach(down); })(sel);
      for (var p = sel.parent; p; p = p.parent) ids[p.id] = 2;
      return ids;
    }, [sel]);

    var link = d3.linkHorizontal().x(function (d) { return d.y; }).y(function (d) { return d.x; });
    var links = layout.links().map(function (l, i) {
      var on = lit && lit[l.source.data.id] && lit[l.target.data.id];
      return h("path", { key: "l" + i, d: link(l), fill: "none", stroke: on ? INK : LINE, strokeWidth: on ? 1.8 : 1.3, opacity: lit && !on ? 0.45 : 1 });
    });
    var nodes = layout.descendants().map(function (d) {
      var n = d.data, r = radius(n), dim = lit && !lit[n.id];
      var mark;
      if (n.kind === "root") mark = h("text", { x: 0, y: 9, textAnchor: "middle", fontSize: 30, fontWeight: 800, fill: INK }, "m.");
      else if (n.kind === "campaign") mark = h("rect", { x: -8, y: -8, width: 16, height: 16, rx: 3, fill: CREAM, stroke: INK, strokeWidth: 1.6 });
      else mark = h("circle", { r: r, fill: n.active ? INK : CREAM, stroke: INK, strokeWidth: sel === n ? 3 : 1.6 });
      var sub = n.kind === "user" && (n.desc || n.quota) ? n.used + "/" + n.quota + (n.desc ? " · " + n.activeDesc + " active of " + n.desc : "") : n.kind === "campaign" ? n.children.length + " in" : "";
      return h("g", {
        key: n.id, transform: "translate(" + d.y + "," + d.x + ")", opacity: dim ? 0.35 : 1, style: { cursor: n.kind === "user" ? "pointer" : "default" },
        onClick: function (e) { e.stopPropagation(); if (n.kind === "user") props.onSelect(n); },
      },
        mark,
        n.kind !== "root" ? h("text", { x: r + 9, y: sub ? -1 : 4, fontSize: 13, fontWeight: sel === n ? 800 : 600, fill: INK, stroke: CREAM, strokeWidth: 4, paintOrder: "stroke", strokeLinejoin: "round" }, n.label) : null,
        sub ? h("text", { x: r + 9, y: 14, fontSize: 11, fill: MUT, stroke: CREAM, strokeWidth: 4, paintOrder: "stroke", strokeLinejoin: "round" }, sub) : null
      );
    });
    return h("svg", { ref: svgRef, onClick: function () { props.onSelect(null); } }, h("g", { ref: gRef }, links, nodes));
  }

  function Stat(p) { return h("div", { className: "stat" + (p.hi ? " hi" : "") }, h("b", null, p.v), h("span", null, p.k)); }

  function Person(p) {
    var n = p.node, u = n.u;
    var inviter = n.parent && n.parent.kind === "user" ? n.parent : null;
    var via = n.parent && n.parent.kind === "campaign" ? n.parent.label : null;
    return h("div", { className: "card" },
      h("div", { className: "mut" }, "Rank " + u.invite_depth + (inviter ? " · invited by " : via ? " · came through " : " · let in by you"), inviter ? h("a", { href: "#", onClick: function (e) { e.preventDefault(); p.onSelect(inviter); } }, inviter.label) : via ? via : null),
      h("div", { className: "who" }, u.name || u.handle),
      u.name ? h("div", { className: "line" }, u.handle) : null,
      u.email ? h("div", { className: "line" }, h("a", { href: "mailto:" + u.email }, u.email)) : h("div", { className: "line mut" }, "No email yet"),
      h("div", { className: "line mut" }, "Joined " + day(u.admitted_at || u.created_at) + (u.last_in ? " · last message " + day(u.last_in) : " · never wrote")),
      h("div", { className: "stats" },
        h(Stat, { v: n.activeDesc, k: "active people they brought (7 d)", hi: true }),
        h(Stat, { v: n.used ? n.yield.toFixed(1) : "-", k: "active per invite used" }),
        h(Stat, { v: n.used + "/" + n.quota, k: "invites used" }),
        h(Stat, { v: n.desc, k: "people below them" }),
        h(Stat, { v: u.msgs7 + " / " + u.msgs, k: "their messages, 7 d / all" }),
        h(Stat, { v: u.jobs || 0, k: "tasks Mell did for them" })
      ),
      n.children.length ? h("h2", null, "They invited") : null,
      n.children.map(function (c) {
        return h("div", { key: c.id, className: "row", onClick: function () { p.onSelect(c); } },
          h("span", { className: "nm" }, c.label), h("span", { className: "k" }, (c.active ? "active" : "quiet") + (c.desc ? " · " + c.desc + " below" : "")));
      }),
      h("button", { className: "close", onClick: function () { p.onSelect(null); } }, "Back to the ranking")
    );
  }

  function App() {
    var st = useState(null), data = st[0], setData = st[1];
    var se = useState(null), selected = se[0], setSelected = se[1];
    var qq = useState(""), q = qq[0], setQ = qq[1];
    var er = useState(""), err = er[0], setErr = er[1];
    var zoomRef = useRef(null);

    useEffect(function () {
      if (DEMO) { setData(demoData()); return; }
      fetch("/admin/graph.json", { credentials: "same-origin" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(setData)
        .catch(function (e) { setErr(String(e.message || e)); });
    }, []);

    var tree = useMemo(function () { return data ? build(data) : null; }, [data]);
    var people = useMemo(function () { return tree ? Object.keys(tree.byId).map(function (k) { return tree.byId[k]; }).filter(function (n) { return n.kind === "user"; }) : []; }, [tree]);
    var ranking = useMemo(function () {
      return people.filter(function (n) { return n.used > 0; }).sort(function (a, b) { return b.activeDesc - a.activeDesc || b.desc - a.desc || b.u.msgs - a.u.msgs; }).slice(0, 25);
    }, [people]);
    var matches = useMemo(function () {
      var s = q.trim().toLowerCase();
      if (!s) return [];
      return people.filter(function (n) { return [n.u.name, n.u.handle, n.u.email].some(function (v) { return v && String(v).toLowerCase().replace(/\s/g, "").indexOf(s.replace(/\s/g, "")) >= 0; }); }).slice(0, 8);
    }, [q, people]);

    function select(n) { setSelected(n); if (n && zoomRef.current) zoomRef.current(n); }

    if (err) return h("div", { style: { padding: 40 } }, "Could not load the graph: " + err);
    if (!tree) return h("div", { style: { padding: 40, color: "#7a766f" } }, "Loading...");

    var active = people.filter(function (n) { return n.active; }).length;
    var full = function () { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); };

    return h(React.Fragment, null,
      h("div", { className: "stage" },
        h(Graph, { tree: tree, selected: selected, onSelect: select, zoomRef: zoomRef }),
        h("div", { className: "top" },
          h("a", { href: "/admin" }, "Admin"),
          h("span", { className: "sum" }, people.length + (people.length === 1 ? " person · " : " people · ") + active + " wrote this week" + (DEMO ? " · demo data" : "")),
          h("span", { className: "grow" }),
          h("button", { onClick: full }, "Full screen")
        ),
        h("div", { className: "legend" },
          h("span", null, h("i", { className: "on" }), "wrote this week"),
          h("span", null, h("i"), "quiet"),
          h("span", null, h("i", { className: "sq" }), "campaign link"),
          h("span", null, "size = people below")
        )
      ),
      h("aside", { className: "panel" },
        h("h1", null, "Invitations"),
        h("div", { className: "mut" }, "Invites shrink down the chain: " + data.quotas.join(", ") + "."),
        h("input", { placeholder: "Find someone: name, number, email", value: q, onChange: function (e) { setQ(e.target.value); } }),
        matches.length ? h("div", null, matches.map(function (n) {
          return h("div", { key: n.id, className: "row", onClick: function () { setQ(""); select(n); } }, h("span", { className: "nm" }, n.label), h("span", { className: "k" }, n.u.email || n.u.handle));
        })) : null,
        selected ? h(Person, { node: selected, onSelect: select })
          : h("div", null,
            h("h2", null, "Who brings the most"),
            ranking.length ? ranking.map(function (n, i) {
              return h("div", { key: n.id, className: "row", onClick: function () { select(n); } },
                h("span", { className: "rank" }, i + 1),
                h("span", { className: "nm", style: { flex: 1 } }, n.label),
                h("span", { className: "k" }, n.activeDesc + " active · " + n.used + "/" + n.quota));
            }) : h("p", { className: "empty" }, "Nobody has invited anyone yet. Their links are in their space and Mell gives them on request.")
          )
      )
    );
  }

  ReactDOM.createRoot(document.getElementById("app")).render(h(App));
})();
