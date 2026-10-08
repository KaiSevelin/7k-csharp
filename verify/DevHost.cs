// Runs a hand-written `IDesk` inside a 7K Sandbox scenario, over the generated development host.
//
// `scripts/devhost.mjs` builds this, spawns it, and drives it with a real scenario. This side owns the
// one thing the other cannot do for it: being somebody's implementation.
//
// **Why this file exists at all.** The dev host was generated, compiled under `dotnet build` with
// warnings as errors, and never run. Both halves of its protocol were written to one specification by
// one author, and until they are introduced to each other all that is proven is that each half
// compiles. The record in this repository argues against trusting that: four compile errors in the
// generator's own output were found only by pointing a compiler at it, and a correlation test that
// passed under FIFO delivery turned out to be asserting nothing.
//
// **The implementation is deliberately ordinary.** It knows nothing about the sandbox, nothing about
// the protocol, and nothing about this harness — the generated interface is its only contact with 7K,
// which is the arrangement the whole dev host exists to make possible. It branches on the message so
// that the scenario can tell from the reply which path ran, because a handler that always answered the
// same way would pass whether or not the body ever arrived.

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Acme;
using Acme.Verify.Common;
using Acme.Verify.Flow;

/// <summary>A desk, written by hand against the generated interface.</summary>
sealed class Desk : IDesk
{
    /// <summary>What it was handed, so the harness can ask whether the body survived the trip.</summary>
    public readonly List<string> Seen = new();

    public Task<IDesk.SubmitOutcome> HandleSubmitAsync(
        Submit message,
        Trace trace,
        CancellationToken cancellationToken)
    {
        Seen.Add($"Submit {message.Ref} {message.Amount.Value} {message.Currency.Value} p{trace.Priority}");
        // Deliberately `Console.WriteLine`, which is what somebody debugging actually types — and
        // stdout is the protocol channel, so this is a frame-shaped hole unless the host has
        // redirected it. The harness checks that this came out on stderr.
        Console.WriteLine($"handling Submit {message.Ref} for {message.Amount.Value}");

        // A handler that fails, which is a different thing from one that refuses. `Refused` is an
        // outcome the model declares; throwing is the code not working, and the subscription's retry
        // policy is what decides what happens next.
        if (message.Currency.Value == "XX")
        {
            throw new InvalidOperationException("the database deadlocked");
        }

        // The decision is the handler's, which is the point: the model declares the outcome space and
        // cannot say which arm runs. A scenario reading `Refused` back has proven the body arrived
        // and was read, not merely that something answered.
        if (message.Amount.Value > 100m)
        {
            return Task.FromResult<IDesk.SubmitOutcome>(
                new Refused { Ref = message.Ref, Reason = new Line60(new Line("over the limit")) });
        }
        return Task.FromResult<IDesk.SubmitOutcome>(new Accepted { Ref = message.Ref });
    }

    public Task HandleWithdrawAsync(Withdraw message, Trace trace, CancellationToken cancellationToken)
    {
        Seen.Add($"Withdraw {message.Ref}");
        return Task.CompletedTask;
    }

    // Declared by the model as a second subscription to the same message, and unreachable from the
    // dispatcher — a delivery carries the message and not the subscription that matched it. The
    // generator says so as a `Loss`; this is here because the interface requires it.
    public Task HandleWithdrawAsSweepAsync(Withdraw message, Trace trace, CancellationToken cancellationToken)
    {
        Seen.Add($"sweep {message.Ref}");
        return Task.CompletedTask;
    }
}

static class Program
{
    static async Task Main()
    {
        var desk = new Desk();
        // Exactly the two lines the generated documentation says to write.
        await SevenKDevHost.RunAsync(new DeskDevHost(desk, SevenKJson.Options), SevenKJson.Options);
    }
}
