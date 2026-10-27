using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

namespace ClaudeDesktopManager.Tests
{
    [AttributeUsage(AttributeTargets.Method)]
    sealed class TestAttribute : Attribute { }

    sealed class AssertException : Exception
    {
        public AssertException(string message) : base(message) { }
    }

    static class Assert
    {
        public static void True(bool cond, string what = "条件")
        {
            if (!cond) throw new AssertException("应为 true：" + what);
        }

        public static void False(bool cond, string what = "条件")
        {
            if (cond) throw new AssertException("应为 false：" + what);
        }

        public static void Equal<T>(T expected, T actual, string what = "")
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
                throw new AssertException((what.Length > 0 ? what + "：" : "") + "期望 <" + expected + ">，实际 <" + actual + ">");
        }

        public static void Null(object o, string what = "")
        {
            if (o != null) throw new AssertException("应为 null：" + what + "，实际 <" + o + ">");
        }

        public static void NotNull(object o, string what = "")
        {
            if (o == null) throw new AssertException("不应为 null：" + what);
        }

        public static void Contains(string needle, string haystack)
        {
            if (haystack == null || haystack.IndexOf(needle, StringComparison.Ordinal) < 0)
                throw new AssertException("没有找到 <" + needle + ">，内容：<" + haystack + ">");
        }

        public static void NotContains(string needle, string haystack)
        {
            if (haystack != null && haystack.IndexOf(needle, StringComparison.Ordinal) >= 0)
                throw new AssertException("不应包含 <" + needle + ">，内容：<" + haystack + ">");
        }

        public static void Seq<T>(IEnumerable<T> expected, IEnumerable<T> actual, string what = "")
        {
            var e = expected.ToList();
            var a = actual.ToList();
            if (!e.SequenceEqual(a))
                throw new AssertException((what.Length > 0 ? what + "：" : "") + "期望 [" + string.Join(", ", e) + "]，实际 [" + string.Join(", ", a) + "]");
        }

        public static T Throws<T>(Action a) where T : Exception
        {
            try { a(); }
            catch (T e) { return e; }
            catch (Exception e) { throw new AssertException("期望抛出 " + typeof(T).Name + "，实际抛出 " + e.GetType().Name + "：" + e.Message); }
            throw new AssertException("期望抛出 " + typeof(T).Name + "，但没有异常");
        }
    }

    sealed class TempDir : IDisposable
    {
        public readonly string Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "cdm-test-" + Guid.NewGuid().ToString("N"));

        public TempDir() { Directory.CreateDirectory(Path); }

        public string File(string name) => System.IO.Path.Combine(Path, name);

        public void Dispose()
        {
            try { Directory.Delete(Path, true); } catch (Exception) { }
        }
    }

    static class Program
    {
        static int Main(string[] args)
        {
            var filter = args.Length > 0 ? args[0] : null;
            var tests = typeof(Program).Assembly.GetTypes()
                .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                .Where(m => m.GetCustomAttribute<TestAttribute>() != null)
                .Where(m => filter == null || (m.DeclaringType.Name + "." + m.Name).IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderBy(m => m.DeclaringType.Name).ThenBy(m => m.Name)
                .ToList();
            int failed = 0;
            foreach (var m in tests)
            {
                var name = m.DeclaringType.Name + "." + m.Name;
                try
                {
                    m.Invoke(null, null);
                    Console.WriteLine("ok   " + name);
                }
                catch (TargetInvocationException e)
                {
                    failed++;
                    var inner = e.InnerException ?? e;
                    Console.WriteLine("FAIL " + name + "\n     " + inner.GetType().Name + ": " + inner.Message);
                    if (!(inner is AssertException)) Console.WriteLine(inner.StackTrace);
                }
            }
            Console.WriteLine();
            Console.WriteLine((tests.Count - failed) + "/" + tests.Count + " passed");
            return failed == 0 && tests.Count > 0 ? 0 : 1;
        }
    }
}
