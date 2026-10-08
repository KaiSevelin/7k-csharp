// Does the generated code say what the model says?
//
// Compiling proves the generator emits C#. This proves it emits the *right* C# — that a message
// violating a rule is reported, that one satisfying every rule is not, and that the path on a problem
// is the path a caller would use to mark a field in a form.
//
// Pinned to the `per-declaration` layout with `wrapper` values and the root namespace `Acme`, which is
// the default shape. The other combinations are checked by the compiler alone.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Acme;
using Acme.Verify.Orders;
using Acme.Verify.Common;

static class Behaviour
{
    static int failures;

    static void Expect(string what, IReadOnlyList<Problem> got, params string[] wanted)
    {
        var lines = got.Select(p => p.ToString()).ToArray();
        var ok = lines.Length == wanted.Length && wanted.All(w => lines.Contains(w));
        Console.WriteLine((ok ? "ok    " : "FAIL  ") + what);
        if (ok) return;
        failures++;
        Console.WriteLine("        got:    [" + string.Join(" | ", lines) + "]");
        Console.WriteLine("        wanted: [" + string.Join(" | ", wanted) + "]");
    }

    static Amount Amt(decimal v, string c) => new Amount { Value = new Money18(v), Currency = new Code(c) };
    static Line60 L(string s) => new Line60(new Line(s));

    static Item It(string sku = "SKU", long qty = 1, string currency = "SE") =>
        new Item { Sku = L(sku), Qty = new Qty(qty), Unit = Amt(10m, currency) };

    static PlaceOrder Order(Status status = Status.Open, string totalCurrency = "SE",
                            string? region = null, params Item[] items) => new PlaceOrder
    {
        OrderId = Guid.Empty,
        Items = items.Length == 0 ? new[] { It() } : items,
        Total = Amt(10m, totalCurrency),
        Buyer = new Person { Email = new Line("a@b.c"), Region = region is null ? null : new Code(region) },
        Status = status,
    };

    static int Main()
    {
        // Nothing wrong states nothing.
        Expect("a valid order", PlaceOrderValidator.Validate(Order()));

        // The cross-field invariant, which is the whole point.
        Expect("a line in another currency",
            PlaceOrderValidator.Validate(Order(items: new[] { It(currency: "SE"), It(currency: "NO") })),
            "invariant total.currency == items[].unit.currency");

        // An invariant against an enum member, which 7K writes as a string.
        Expect("a cancelled order",
            PlaceOrderValidator.Validate(Order(status: Status.Cancelled)),
            "invariant status != \"Cancelled\"");

        // `size` on the list itself. An empty array, not the default.
        Expect("no items at all",
            PlaceOrderValidator.Validate(new PlaceOrder
            {
                OrderId = Guid.Empty, Items = Array.Empty<Item>(), Total = Amt(10m, "SE"),
                Buyer = new Person { Email = new Line("a@b.c") }, Status = Status.Open,
            }),
            "items: size 1..50");

        // A rule two levels down, through a list, on a value that refines another value.
        Expect("a sku too long for Line60",
            PlaceOrderValidator.Validate(Order(items: new[] { It(sku: new string('x', 70)) })),
            "items[].sku: length 1..60");

        // Both hops bind: 300 characters breaks Line60's 60 and Line's 255.
        Expect("a sku too long for Line as well",
            PlaceOrderValidator.Validate(Order(items: new[] { It(sku: new string('x', 300)) })),
            "items[].sku: length 1..60", "items[].sku: length 1..255");

        Expect("a quantity out of range",
            PlaceOrderValidator.Validate(Order(items: new[] { It(qty: 0) })),
            "items[].qty: range 1..99");

        // An optional field absent is legal; the same field present and wrong is not.
        Expect("no region", PlaceOrderValidator.Validate(Order(region: null)));
        Expect("a lowercase region",
            PlaceOrderValidator.Validate(Order(region: "se")),
            "buyer.region: pattern /^[A-Z]{2}$/");

        // The path is the point: a caller marks a field without parsing a message.
        var problems = PlaceOrderValidator.Validate(Order(items: new[] { It(qty: 0) }));
        var paths = problems.Select(p => p.Path).ToArray();
        Console.WriteLine(paths.Contains("items[].qty") ? "ok    the path is usable on its own"
                                                        : "FAIL  the path is usable on its own");
        if (!paths.Contains("items[].qty")) failures++;

        // `include` splices, so a rule on an included field is checked through the holder.
        Expect("a name too long, through an include",
            SpreadValidator.Validate(new Spread { Name = L(new string('x', 70)) }),
            "name: length 1..60");

        failures += Shape.Check().GetAwaiter().GetResult();
        failures += Canonical.Check();

        Console.WriteLine(failures == 0 ? "ALL OK" : failures + " FAILED");
        return failures == 0 ? 0 : 1;
    }
}

// Can a generated handler interface actually be implemented?
//
// Compiling the interface proves it is valid C#. This proves it is *usable*: that the outcome union can
// be returned from a handler, that the envelope arrives as a parameter, and — the part worth having — that
// a `switch` over the outcome which misses a case is a compiler error rather than a runtime surprise.
//
// Nothing here calls out to anything. The point is the shape, not the behaviour.
file sealed class Desk : Acme.Verify.Flow.IDesk
{
    public Task<Acme.Verify.Flow.IDesk.SubmitOutcome> HandleSubmitAsync(
        Acme.Verify.Flow.Submit message,
        Acme.Verify.Common.Trace trace,
        CancellationToken cancellationToken)
    {
        // The implicit conversion, so a handler returns the message rather than naming the case.
        if (message.Amount.Value > 0)
            return Task.FromResult<Acme.Verify.Flow.IDesk.SubmitOutcome>(
                new Acme.Verify.Flow.Accepted { Ref = message.Ref });

        return Task.FromResult<Acme.Verify.Flow.IDesk.SubmitOutcome>(
            new Acme.Verify.Flow.Refused
            {
                Ref = message.Ref,
                Reason = new Acme.Verify.Common.Line60(new Acme.Verify.Common.Line("not positive")),
            });
    }

    public Task HandleWithdrawAsync(
        Acme.Verify.Flow.Withdraw message,
        Acme.Verify.Common.Trace trace,
        CancellationToken cancellationToken) => Task.CompletedTask;

    public Task HandleWithdrawAsSweepAsync(
        Acme.Verify.Flow.Withdraw message,
        Acme.Verify.Common.Trace trace,
        CancellationToken cancellationToken) => Task.CompletedTask;
}

static class Shape
{
    /// <summary>What the host would do with an outcome: route it, exhaustively.</summary>
    static string Route(Acme.Verify.Flow.IDesk.SubmitOutcome outcome) => outcome.Match(
        // One delegate per declared reply. Drop either and this stops compiling — which is the whole
        // reason a union type is generated rather than a comment saying "return one of these".
        accepted => $"accepted {accepted.Ref}",
        refused => $"refused {refused.Reason}");

    public static async Task<int> Check()
    {
        var desk = new Desk();
        var trace = new Acme.Verify.Common.Trace { CorrelationId = Guid.Empty, Priority = 1 };
        var submit = new Acme.Verify.Flow.Submit
        {
            Ref = Guid.Empty,
            Amount = new Acme.Verify.Common.Money18(5m),
            Currency = new Acme.Verify.Common.Code("SE"),
        };

        var accepted = Route(await desk.HandleSubmitAsync(submit, trace, default));
        var refused = Route(await desk.HandleSubmitAsync(submit with { Amount = new Acme.Verify.Common.Money18(0m) }, trace, default));

        var ok = accepted.StartsWith("accepted") && refused.StartsWith("refused");
        Console.WriteLine((ok ? "ok    " : "FAIL  ") + "a generated handler interface can be implemented and routed");
        return ok ? 0 : 1;
    }
}

// Does a generated type produce the canonical JSON the contract says it does?
//
// `01-kernel.md` 7 is one of the three artifacts D48 publishes, so this is not a convenience test: a
// type that serialises to something else is a type that does not implement the contract it was
// generated from. Round-tripping matters as much as the bytes — and it also exercises the generated
// value equality, since comparing the two ends is how you check a round trip at all.
static class Canonical
{
    static int failures;

    static void Same(string what, string got, string wanted)
    {
        var ok = got == wanted;
        Console.WriteLine((ok ? "ok    " : "FAIL  ") + what);
        if (ok) return;
        failures++;
        Console.WriteLine("        got:    " + got);
        Console.WriteLine("        wanted: " + wanted);
    }

    static void True(string what, bool ok)
    {
        Console.WriteLine((ok ? "ok    " : "FAIL  ") + what);
        if (!ok) failures++;
    }

    public static int Check()
    {
        var options = Acme.SevenKJson.Options;

        // A nominal value collapses to what it refines, and a decimal is a string with its scale.
        var amount = new Acme.Verify.Common.Amount
        {
            Value = new Acme.Verify.Common.Money18(12.5m),
            Currency = new Acme.Verify.Common.Code("SE"),
        };
        Same("a nominal value and a decimal",
            JsonSerializer.Serialize(amount, options),
            """{"value":"12.50","currency":"SE"}""");

        // An enum is its declared member name, never an index.
        var everything = Sample();
        var json = JsonSerializer.Serialize(everything, options);
        True("an enum is its member name", json.Contains("\"anEnum\":\"Shipped\""));

        // `bytes` is base64url without padding.
        True("bytes are base64url, unpadded", json.Contains("\"someBytes\":\"AQID\""));

        // An instant is UTC with microsecond precision.
        True("an instant is UTC to microseconds",
            json.Contains("\"anInstant\":\"2026-10-05T14:22:05.123456Z\""));

        // A duration is ISO 8601.
        True("a duration is ISO 8601", json.Contains("\"aDuration\":\"PT1H30M\""));

        // An `int` whose declared range reaches past 2^53 travels as text (`01-kernel.md` 7.1). The
        // digits matter: written as a JSON number this is exact in C# and rounds to ...920 the moment
        // a JavaScript reader parses it, which is the interop the rule exists for.
        True("a wide int is written as a string",
            json.Contains("\"balance\":\"90071992547409921\""));
        True("and not as a number", !json.Contains("\"balance\":90071992547409921"));

        // An absent optional field has its key omitted. There is no null in 7K.
        True("an absent optional field is omitted", !json.Contains("optional"));
        True("and nothing is written as null", !json.Contains("null"));

        // The whole thing round-trips, compared with the generated value equality.
        var back = JsonSerializer.Deserialize<Acme.Verify.Orders.Everything>(json, options)!;
        True("it round-trips", back == everything);
        True("and the wide int comes back to the digit",
            back.Balance is { } b && b.Value == 90071992547409921L);
        Same("and re-serialises to the same bytes", JsonSerializer.Serialize(back, options), json);

        // A message with a list round-trips too, which is what the equality fix is for.
        var order = new Acme.Verify.Orders.PlaceOrder
        {
            OrderId = Guid.Parse("11111111-1111-1111-1111-111111111111"),
            Items = new[] { new Acme.Verify.Orders.Item
            {
                Sku = new Acme.Verify.Common.Line60(new Acme.Verify.Common.Line("SKU")),
                Qty = new Acme.Verify.Common.Qty(2),
                Unit = amount,
            } },
            Total = amount,
            Buyer = new Acme.Verify.Common.Person { Email = new Acme.Verify.Common.Line("a@b.c") },
            Status = Acme.Verify.Common.Status.Open,
        };
        var orderJson = JsonSerializer.Serialize(order, options);
        True("a message holding a list round-trips",
            JsonSerializer.Deserialize<Acme.Verify.Orders.PlaceOrder>(orderJson, options) == order);

        // Two identical messages are the same message, which is the whole reason a record was chosen.
        True("two identical messages are equal", Clone(order) == order);
        True("and hash the same", Clone(order).GetHashCode() == order.GetHashCode());
        True("so a set holds one of them",
            new HashSet<Acme.Verify.Orders.PlaceOrder> { order, Clone(order) }.Count == 1);

        // A nominal value over a collection: the wrapper struct needs the same fix the record did.
        var one = new Acme.Verify.Common.Person
        {
            Email = new Acme.Verify.Common.Line("a@b.c"),
            Token = new Acme.Verify.Common.Payload(new byte[] { 9, 8 }),
        };
        var two = new Acme.Verify.Common.Person
        {
            Email = new Acme.Verify.Common.Line("a@b.c"),
            Token = new Acme.Verify.Common.Payload(new byte[] { 9, 8 }),
        };
        True("a value wrapping a collection compares by contents", one == two);
        True("and round-trips",
            JsonSerializer.Deserialize<Acme.Verify.Common.Person>(
                JsonSerializer.Serialize(one, options), options) == one);

        // A map with a nominal key encodes as an object keyed by the refined value.
        True("a map's keys collapse too", json.Contains("\"aMap\":{\"SE\":"));

        return failures;
    }

    static Acme.Verify.Orders.PlaceOrder Clone(Acme.Verify.Orders.PlaceOrder it) => it with { };

    static Acme.Verify.Orders.Everything Sample()
    {
        var amount = new Acme.Verify.Common.Amount
        {
            Value = new Acme.Verify.Common.Money18(12.5m),
            Currency = new Acme.Verify.Common.Code("SE"),
        };
        return new Acme.Verify.Orders.Everything
        {
            AnId = Guid.Parse("11111111-1111-1111-1111-111111111111"),
            ABool = true,
            AnInt = 7,
            AFloat = 1.5,
            AString = "hello",
            SomeBytes = new byte[] { 1, 2, 3 },
            AnInstant = new DateTimeOffset(2026, 10, 5, 14, 22, 5, TimeSpan.Zero).AddTicks(1234560),
            ADuration = TimeSpan.FromMinutes(90),
            ADate = new DateOnly(2026, 10, 5),
            ADecimal = 3.25m,
            AList = new[] { new Acme.Verify.Common.Line60(new Acme.Verify.Common.Line("one")) },
            AMap = new Dictionary<Acme.Verify.Common.Code, Acme.Verify.Common.Amount>
            {
                [new Acme.Verify.Common.Code("SE")] = amount,
            },
            AnEnum = Acme.Verify.Common.Status.Shipped,
            Nested = new Acme.Verify.Common.Spread { Name = new Acme.Verify.Common.Line60(new Acme.Verify.Common.Line("n")) },
            Plain = new Acme.Verify.Common.Plain { Note = "p" },
            // Past 2^53, which is what makes the encoding below worth asserting: a `long` holds it
            // and a JSON number does not.
            Balance = new Acme.Verify.Common.Ledger(90071992547409921L),
        };
    }
}
