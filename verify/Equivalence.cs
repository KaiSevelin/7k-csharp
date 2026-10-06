// Drives the generated saga machine from the same scripts the sandbox's engine is driven from.
//
// `scripts/equivalence.mjs` runs both and compares. This side owns three things the other cannot do
// for it: building the fixture's messages from a script, keeping the timers the machine asks for, and
// writing out what the machine decided.
//
// The message factory is written by hand rather than deserialised, deliberately. Reflecting JSON into
// records with required properties and nominal value wrappers would need a converter per wrapper, and a
// bug in that converter would look exactly like a disagreement about the saga.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Acme;
using Acme.Verify.Common;
using Acme.Verify.Flow;
using Acme.Verify.Fanout;

static class Equivalence
{
    static int Main()
    {
        // Beside the executable's project, where `equivalence.mjs` copies them.
        const string dir = "scripts";
        foreach (var path in Directory.GetFiles(dir, "*.json").OrderBy(p => p, StringComparer.Ordinal))
        {
            Console.WriteLine("## " + Path.GetFileNameWithoutExtension(path));
            foreach (var decision in Run(JsonNode.Parse(File.ReadAllText(path))!.AsObject()))
                Console.WriteLine(decision);
        }
        return 0;
    }

    static (ISagaMachine, IReadOnlyList<SagaEffect>) Begin(HandoverSaga.Begun begun) =>
        (begun.Saga, begun.Effects);

    static (ISagaMachine, IReadOnlyList<SagaEffect>) Begin(FanoutSaga.Begun begun) =>
        (begun.Saga, begun.Effects);

    /// <summary>One pending timer, as a host would hold it.</summary>
    sealed record Timer(long At, int Id, string? Step, int Stage);

    /// <summary>
    /// Runs one script.
    ///
    /// The machine decides; this performs. Arming and cancelling timers is the host's job, and doing it
    /// here rather than inside the machine is what keeps the machine free of a clock.
    /// </summary>
    static IReadOnlyList<string> Run(JsonObject script)
    {
        var decisions = new List<string>();
        var timers = new List<Timer>();
        var uncancellable =
            script.TryGetPropertyValue("uncancellableTimers", out var flag) && flag!.GetValue<bool>();
        long now = 0;
        var nextTimer = 0;

        var start = script["start"]!.AsObject();
        var trace = new Trace { CorrelationId = Guid.Empty, Priority = 0 };
        var message = Build(start["type"]!.GetValue<string>(), start["body"]!.AsObject());

        // The typed `Start` is each saga's own; everything after it is `ISagaMachine`.
        var (saga, opening) = script["saga"]!.GetValue<string>() switch
        {
            "verify.flow.Handover" => Begin(HandoverSaga.Start((Submit)message, trace)),
            "verify.fanout.Fanout" => Begin(FanoutSaga.Start((Gather)message, trace)),
            var other => throw new ArgumentException($"the harness drives no saga named `{other}`"),
        };
        Perform(opening);

        void Perform(IReadOnlyList<SagaEffect> effects)
        {
            foreach (var effect in effects)
            {
                switch (effect)
                {
                    case SagaEffect.Started s:
                        decisions.Add(Line("started", s.Key));
                        break;
                    case SagaEffect.Advanced a:
                        decisions.Add(Line("advanced", a.Step, a.MessageType));
                        break;
                    case SagaEffect.TimedOut t:
                        decisions.Add(Line("timedout", t.Step));
                        break;
                    case SagaEffect.Compensating c:
                        decisions.Add(Line("compensating", c.Step, c.MessageType));
                        break;
                    case SagaEffect.Irreversible i:
                        decisions.Add(Line("irreversible", i.Step));
                        break;
                    case SagaEffect.Ended e:
                        decisions.Add(Line("ended", e.Status.ToString().ToLowerInvariant(), e.Step, e.Reason));
                        break;
                    case SagaEffect.Send s:
                        decisions.Add(Line("send", s.MessageType, Json(Normalise(s.Message))));
                        break;

                    // The rest is bookkeeping a host does and a trace does not record.
                    case SagaEffect.ArmTimeout arm:
                        timers.Add(new Timer(now + arm.AfterMs, nextTimer++, arm.Step, arm.Stage));
                        break;
                    case SagaEffect.CancelTimeout cancel:
                        // A script may declare that this host cannot cancel — a delayed queue message
                        // or a cloud scheduler cannot be recalled — so that the late firing has to be
                        // made harmless by the machine's own guard.
                        if (!uncancellable) timers.RemoveAll(t => t.Step == cancel.Step);
                        break;
                    case SagaEffect.ArmDeadline deadline:
                        timers.Add(new Timer(now + deadline.AfterMs, nextTimer++, null, 0));
                        break;
                    case SagaEffect.CancelDeadline:
                        if (!uncancellable) timers.RemoveAll(t => t.Step is null);
                        break;
                }
            }
        }

        void AdvanceTo(long until)
        {
            while (true)
            {
                var due = timers.Where(t => t.At <= until).OrderBy(t => t.At).ThenBy(t => t.Id).ToList();
                if (due.Count == 0) break;
                var next = due[0];
                timers.Remove(next);
                now = next.At;
                Perform(next.Step is null ? saga.Deadline() : saga.Timeout(next.Step, next.Stage));
            }
            now = until;
        }

        foreach (var input in script["inputs"]!.AsArray())
        {
            var obj = input!.AsObject();
            if (obj.TryGetPropertyValue("deliver", out var type))
                Perform(saga.Deliver(Build(type!.GetValue<string>(), obj["body"]!.AsObject())));
            else if (obj.TryGetPropertyValue("advance", out var ms))
                AdvanceTo(now + ms!.GetValue<long>());
        }

        return decisions;
    }

    static string Line(params string?[] parts) =>
        string.Join(" | ", parts.Select(p => p ?? "-"));

    static string Json(JsonNode? node) => node?.ToJsonString() ?? "null";

    /// <summary>
    /// A message as a tree both sides can compare.
    ///
    /// Reflection here and not for `Build`, because going out is unambiguous: a 7K value wrapper is a
    /// record struct with one property called `Value`, and everything else is its properties.
    /// </summary>
    static JsonNode? Normalise(object? value)
    {
        switch (value)
        {
            case null:
                return null;
            case string s:
                return JsonValue.Create(s);
            case Guid g:
                return JsonValue.Create(g.ToString());
            case bool b:
                return JsonValue.Create(b);
            case decimal d:
                return JsonValue.Create(d);
            case long or int or double or float:
                return JsonValue.Create(Convert.ToDouble(value, CultureInfo.InvariantCulture));
            case DateTimeOffset dto:
                return JsonValue.Create(dto.ToString("O", CultureInfo.InvariantCulture));
            case DateOnly only:
                return JsonValue.Create(only.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
            case TimeSpan span:
                return JsonValue.Create(span.ToString());
        }

        if (value is System.Collections.IEnumerable items)
        {
            var array = new JsonArray();
            foreach (var item in items) array.Add(Normalise(item));
            return array;
        }

        var properties = value.GetType().GetProperties();

        // A nominal value: `readonly record struct Code(string Value)`.
        if (value.GetType().IsValueType && properties.Length == 1 && properties[0].Name == "Value")
            return Normalise(properties[0].GetValue(value));

        var obj = new JsonObject();
        foreach (var property in properties.OrderBy(p => p.Name, StringComparer.Ordinal))
            obj[Lower(property.Name)] = Normalise(property.GetValue(value));
        return obj;
    }

    /// <summary>A C# property name back to the field name the model uses.</summary>
    static string Lower(string name) => char.ToLowerInvariant(name[0]) + name.Substring(1);

    /// <summary>
    /// The fixture's messages, built from a script.
    ///
    /// Hand-written: see the header. Add a message to `verify/model/flow.7k` that a script delivers and
    /// this is where it goes.
    /// </summary>
    static object Build(string type, JsonObject body)
    {
        Guid Id(string field) => Guid.Parse(body[field]!.GetValue<string>());
        decimal Amount(string field) =>
            decimal.Parse(body[field]!.GetValue<string>(), CultureInfo.InvariantCulture);
        string Text(string field) => body[field]!.GetValue<string>();

        return type switch
        {
            "verify.flow.Submit" => new Submit
            {
                Ref = Id("ref"),
                Amount = new Money18(Amount("amount")),
                Currency = new Code(Text("currency")),
            },
            "verify.flow.Approved" => new Approved { Ref = Id("ref"), AuthId = Id("authId") },
            "verify.flow.Declined" => new Declined { Ref = Id("ref") },
            "verify.flow.Shipped" => new Shipped { Ref = Id("ref") },
            "verify.flow.Unshippable" => new Unshippable { Ref = Id("ref") },
            "verify.flow.Noted" => new Noted { Ref = Id("ref") },

            "verify.fanout.Gather" => new Gather { Ref = Id("ref") },
            "verify.fanout.LeftSaid" => new LeftSaid { Ref = Id("ref"), Value = new Line60(new Line(Text("value"))) },
            "verify.fanout.RightSaid" => new RightSaid { Ref = Id("ref"), Value = new Line60(new Line(Text("value"))) },
            "verify.fanout.RightEmpty" => new RightEmpty { Ref = Id("ref") },
            "verify.fanout.Done" => new Done { Ref = Id("ref") },
            _ => throw new ArgumentException($"the harness cannot build `{type}`", nameof(type)),
        };
    }
}
