/*
 * vim-unit adapter for IdeaVim.
 *
 * This file is not part of IdeaVim. The vim-unit integration script (integrations/ideavim/run.sh in the vim-unit
 * repository) copies it into an IdeaVim checkout at
 * src/test/java/org/jetbrains/plugins/ideavim/vimunit/VimUnitSuiteTest.kt and runs it with
 *
 *   ./gradlew :test --tests org.jetbrains.plugins.ideavim.vimunit.VimUnitSuiteTest --rerun
 *
 * It reads the suite exported by `vimunit export` from build/vimunit/tests.json (found by walking up from the working
 * directory, or given with -Dvimunit.dir / $VIMUNIT_DIR), runs every vim-unit test as one invocation of a JUnit 5
 * parameterized test (so each gets VimTestCase's fresh light fixture and editor), and appends one JSON line per step to
 * build/vimunit/results.jsonl, in the format described in vim-unit's doc/integrating.md. Exceptions and errors logged by
 * IdeaVim are written to build/vimunit/diagnostics.log.
 *
 * Mismatches don't fail the JUnit test; `vimunit report` does the scoring. A JUnit test fails only if the adapter itself
 * couldn't run the vim-unit test, and is reported as skipped (aborted) if the vim-unit test was skipped.
 */
package org.jetbrains.plugins.ideavim.vimunit

import com.intellij.application.options.CodeStyle
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.PlatformCoreDataKeys
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.ex.util.EditorUtil
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.keymap.KeymapManager
import com.intellij.testFramework.LoggedErrorProcessor
import com.intellij.testFramework.PlatformTestUtil
import com.maddyhome.idea.vim.KeyHandler
import com.maddyhome.idea.vim.action.VimShortcutKeyAction
import com.maddyhome.idea.vim.action.change.VimRepeater
import com.maddyhome.idea.vim.action.motion.leftright.TillCharacterMotionType
import com.maddyhome.idea.vim.api.VimChangeGroupBase
import com.maddyhome.idea.vim.api.VimSearchGroupBase
import com.maddyhome.idea.vim.api.globalOptions
import com.maddyhome.idea.vim.api.injector
import com.maddyhome.idea.vim.helper.TestInputModel
import com.maddyhome.idea.vim.newapi.vim
import com.maddyhome.idea.vim.options.OptionAccessScope
import com.maddyhome.idea.vim.options.ToggleOption
import com.maddyhome.idea.vim.state.mode.Mode
import com.maddyhome.idea.vim.vimscript.model.datatypes.VimDataType
import com.maddyhome.idea.vim.vimscript.model.datatypes.VimInt
import org.jetbrains.plugins.ideavim.VimTestCase
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.TestInfo
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.awt.event.KeyEvent
import java.io.File
import java.util.Date
import java.util.EnumSet
import javax.swing.KeyStroke

class VimUnitSuiteTest : VimTestCase() {

  /** The buffer and cursor after a step. The column counts UTF-16 code units, as the IntelliJ document does. */
  private data class BufferState(val lines: List<String>, val line: Int, val column: Int)

  /** Thrown when the test can't be run, with the reason recorded for each step. */
  private class SkipTest(reason: String) : Exception(reason)

  private var temporaryCodeStyle = false
  private var currentId = ""
  private var currentStep = 0

  @BeforeEach
  override fun setUp(testInfo: TestInfo) {
    super.setUp(testInfo)
    // VimTestCase turns on strict mode, which throws on internal inconsistencies that IdeaVim only logs in the IDE.
    injector.globalOptions().ideastrictmode = false
    resetStateVimTestCaseKeeps()
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("vimUnitTests")
  fun vimunit(id: String, index: Int) {
    Assumptions.assumeTrue(index >= 0, "no vim-unit export found (run integrations/ideavim/run.sh)")
    val test = suite!!.tests[index]
    currentId = id
    currentStep = 0
    val stepCount = test.arr("steps").size
    var reported = 0 // steps with a line in the results file
    var skipReason: String? = null
    try {
      LoggedErrorProcessor.executeWith<Throwable>(errorRecorder) {
        try {
          runTest(test) { reported++ }
        } catch (e: SkipTest) {
          skipReason = e.message
        }
      }
    } catch (t: Throwable) {
      diagnostic("adapter threw: ${t.stackTraceToString()}")
      for (step in reported + 1..stepCount) {
        writeResult(errorLine(id, step, "adapter threw: $t"))
      }
      throw t
    } finally {
      if (temporaryCodeStyle) {
        CodeStyle.dropTemporarySettings(fixture.project)
        temporaryCodeStyle = false
      }
    }
    skipReason?.let { reason ->
      for (step in reported + 1..stepCount) writeResult(skipLine(id, step, reason))
      Assumptions.assumeTrue(false, reason)
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Running a test

  private fun runTest(test: Map<String, Any?>, onStepReported: () -> Unit) {
    val id = test.str("id")
    val options = effectiveOptions(test)
    staticSkipReason(test, options)?.let { throw SkipTest(it) }

    val initial = test.obj("initial")
    val initialLines = initial.arr("lines").map { it as String }
    val initialCursor = initial.obj("cursor")
    val text = initialLines.joinToString("\n")
    if (FIXTURE_MARKUP.any { text.contains(it) }) {
      throw SkipTest("buffer contains IntelliJ test-fixture markup (<caret>, <selection> or <block>)")
    }

    // 'tabstop', 'shiftwidth' and 'expandtab' are IntelliJ code style settings, not IdeaVim options. They have to be in
    // place before the editor is created.
    applyCodeStyle(options)

    // Load the buffer. The fixture puts the caret at the <caret> marker.
    val offset = offsetOf(initialLines, initialCursor.int("line"), initialCursor.int("utf16Column"))
    configureByText(text.substring(0, offset) + "<caret>" + text.substring(offset))

    val window = test.obj("window")
    onEdt {
      fixture.editor.settings.setTabSize(options["tabstop"].asInt())
      applyVimOptions(options)
    }
    setEditorVisibleSize(window.int("width"), window.int("height"))
    onEdt {
      fixture.editor.scrollingModel.scrollVertically(0)
      fixture.editor.scrollingModel.scrollHorizontally(0)
      PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
    }

    for ((i, step) in test.arr("steps").withIndex()) {
      step as Map<String, Any?>
      currentStep = i + 1
      val keys = step.arr("keyTokens").map { it as String }
      typeKeys(keys.flatMap { keyStrokes(it) })
      val actual = readState()
      writeResult(stateLine(id, i + 1, actual))
      onStepReported()

      val expectedState = step.obj("expected")
      val expectedCursor = expectedState.obj("cursor")
      val expected = BufferState(
        expectedState.arr("lines").map { it as String },
        expectedCursor.int("line"),
        expectedCursor.int("utf16Column"),
      )
      if (actual != expected) {
        resetTo(expected)
      } else if (!inCleanNormalMode()) {
        // The step must end in Normal mode. Only the text and cursor are scored, but the next step has to start clean.
        diagnostic("step ended in ${onEdt { fixture.editor.vim.mode }} with the expected text; resetting to Normal mode")
        onEdt { forceNormalMode() }
      }
    }
  }

  /** Types keys the way the IDE delivers them: typed characters to the editor, other key presses as actions. */
  private fun typeKeys(keys: List<KeyStroke>) {
    onEdt {
      val editor = fixture.editor
      // VimTestCase's input model; IdeaVim reads further keys from it in a few places in unit test mode.
      val inputModel = TestInputModel.getInstance(editor)
      inputModel.setKeyStrokes(keys)
      var key = inputModel.nextKeyStroke()
      while (key != null) {
        try {
          deliverKey(editor, key)
        } catch (t: Throwable) {
          // In the IDE, an exception from a key event is logged and the following keys are still processed.
          diagnostic("exception while handling key $key: ${t.stackTraceToString()}")
        }
        try {
          PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        } catch (t: Throwable) {
          diagnostic("exception from queued events after key $key: ${t.stackTraceToString()}")
        }
        key = inputModel.nextKeyStroke()
      }
    }
  }

  /**
   * Delivers one key, following VimTestCase's "via IDE" key handling: a key that types a character goes to the editor's
   * typed-action handler (which IdeaVim replaces), and any other key press is offered to IdeaVim's
   * VimShortcutKeyAction, as the IDE's key event dispatcher does. If IdeaVim declines the key (e.g. Enter or the arrow
   * keys while a completion popup is open), it goes to the IDE's own action for it, as in the IDE.
   */
  private fun deliverKey(editor: Editor, key: KeyStroke) {
    if (key.keyChar != KeyEvent.CHAR_UNDEFINED) {
      fixture.type(key.keyChar)
      return
    }
    val vimAction = VimShortcutKeyAction.instance
    if (performIfEnabled(editor, key, vimAction)) return

    val keymap = KeymapManager.getInstance().activeKeymap
    for (actionId in keymap.getActionIds(key)) {
      if (actionId == "VimShortcutKeyAction") continue
      val action = ActionManager.getInstance().getAction(actionId) ?: continue
      if (performIfEnabled(editor, key, action)) {
        diagnostic("IdeaVim declined key $key; the IDE performed $actionId")
        return
      }
    }
    diagnostic("key $key was handled by neither IdeaVim nor an IDE action")
  }

  private fun performIfEnabled(editor: Editor, key: KeyStroke, action: AnAction): Boolean {
    val event = KeyEvent(editor.component, KeyEvent.KEY_PRESSED, Date().time, key.modifiers, key.keyCode, key.keyChar)
    val context = SimpleDataContext.builder()
      .setParent(EditorUtil.getEditorDataContext(editor))
      .add(PlatformCoreDataKeys.CONTEXT_COMPONENT, editor.component)
      .build()
    val e = AnActionEvent(
      event,
      context,
      ActionPlaces.KEYBOARD_SHORTCUT,
      action.templatePresentation.clone(),
      ActionManager.getInstance(),
      0,
    )
    if (!ActionUtil.lastUpdateAndCheckDumb(action, e, true)) return false
    ActionUtil.performActionDumbAwareWithCallbacks(action, e)
    return true
  }

  private fun readState(): BufferState = onEdt {
    PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
    val editor = fixture.editor
    val document = editor.document
    val offset = editor.caretModel.primaryCaret.offset
    val line = document.getLineNumber(offset)
    BufferState(
      document.charsSequence.toString().split('\n'),
      line,
      offset - document.getLineStartOffset(line),
    )
  }

  private fun inCleanNormalMode(): Boolean = onEdt {
    fixture.editor.vim.mode is Mode.NORMAL &&
      injector.commandLine.getActiveCommandLine() == null &&
      injector.modalInput.getCurrentModalInput() == null &&
      !injector.registerGroup.isRecording
  }

  /** Runs [action] on the EDT and returns its result, rethrowing anything it throws on this thread. */
  private fun <T> onEdt(action: () -> T): T {
    var result: Result<T>? = null
    ApplicationManager.getApplication().invokeAndWait { result = runCatching(action) }
    return result!!.getOrThrow()
  }

  /** After a mismatch: back to Normal mode, with the expected text and cursor, so that later steps can still pass. */
  private fun resetTo(expected: BufferState) {
    onEdt {
      forceNormalMode()
      val editor = fixture.editor
      val text = expected.lines.joinToString("\n")
      if (editor.document.text != text) {
        WriteCommandAction.runWriteCommandAction(fixture.project, Runnable { editor.document.setText(text) })
      }
      editor.caretModel.removeSecondaryCarets()
      editor.caretModel.moveToOffset(offsetOf(expected.lines, expected.line, expected.column))
      PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
    }
  }

  private fun forceNormalMode() {
    val vimEditor = fixture.editor.vim
    try {
      injector.commandLine.getActiveCommandLine()?.deactivate(refocusOwningEditor = true, resetCaret = false)
      injector.modalInput.getCurrentModalInput()?.deactivate(refocusOwningEditor = true, resetCaret = false)
      if (injector.registerGroup.isRecording) {
        injector.registerGroup.finishRecording(
          vimEditor,
          injector.executionContextManager.getEditorExecutionContext(vimEditor),
        )
      }
    } catch (t: Throwable) {
      diagnostic("exception while leaving the step's mode: ${t.stackTraceToString()}")
    }
    KeyHandler.getInstance().fullReset(vimEditor)
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Fresh state

  /**
   * VimTestCase resets most of IdeaVim's global state between tests (registers, marks, jumps, search, history, `.`
   * insert repeat, options), but not all of it. A vim-unit test starts as if IdeaVim had just been loaded, so reset the
   * rest to IdeaVim's own initial values. Fields without a public setter are reset reflectively.
   */
  private fun resetStateVimTestCaseKeeps() {
    // The last f/t/F/T for ; and , (IdeaVim's initial value is "t<Space>")
    injector.motion.setLastFTCmd(TillCharacterMotionType.LAST_SMALL_T, ' ')
    // The last macro executed, for @@
    injector.macro.lastRegister = 0.toChar()
    // The last change, for .
    VimRepeater.repeatHandler = false
    VimRepeater.lastChangeRegister = injector.registerGroup.defaultRegister
    resetField(VimRepeater::class.java, null, "lastChangeCommand", null)
    // The last :s replacement string (for ~ in a replacement, &, :s//~/)
    resetField(VimSearchGroupBase::class.java, null, "lastSubstituteString", null)
    resetField(VimSearchGroupBase::class.java, null, "lastReplaceString", null)
    // The last inserted text (". register, i_CTRL-A) and the last insert command
    resetField(VimChangeGroupBase::class.java, injector.changeGroup, "lastStrokes", null)
    resetField(VimChangeGroupBase::class.java, injector.changeGroup, "lastInsert", null)
    // The last :! command, for :!!
    try {
      resetField(
        Class.forName("com.maddyhome.idea.vim.vimscript.model.commands.CmdFilterCommand"),
        null,
        "lastCommand",
        null,
      )
    } catch (t: Throwable) {
      diagnostic("could not reset CmdFilterCommand.lastCommand: $t")
    }
  }

  private fun resetField(cls: Class<*>, target: Any?, name: String, value: Any?) {
    try {
      val field = cls.getDeclaredField(name)
      field.isAccessible = true
      field.set(target, value)
    } catch (t: Throwable) {
      diagnostic("could not reset ${cls.name}.$name: $t")
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Options

  /** The baseline options with the test's options applied. */
  private fun effectiveOptions(test: Map<String, Any?>): Map<String, Any?> =
    suite!!.baselineOptions + test.obj("options")

  /** Why the test can't be run, judging from its metadata, or null. */
  private fun staticSkipReason(test: Map<String, Any?>, options: Map<String, Any?>): String? {
    if (test.arr("definitions").isNotEmpty()) {
      return "go-to-definition metadata (:definition) can't be supplied to IntelliJ for a plain text file"
    }

    for ((name, value) in test.obj("options")) {
      if (name in VIM_OPTIONS || name in CODE_STYLE_OPTIONS) continue
      if (name !in suite!!.baselineOptions) return "option '$name' is unknown to the adapter"
      val fixed = FIXED_OPTION_VALUES[name] ?: suite!!.baselineOptions[name]
      if (value != fixed) {
        return "IdeaVim has no '$name' option (its behaviour corresponds to $name=${formatValue(fixed)})"
      }
    }
    if (options["tabstop"].asInt() <= 0) return "invalid 'tabstop'"

    // Marker folding: IntelliJ folds plain text by nothing, so IdeaVim can't fold at {{{ and }}}.
    if (options["foldmethod"] == "marker" && options["foldenable"] == true) {
      val markers = (options["foldmarker"] as? String ?: "{{{,}}}").split(',').filter { it.isNotEmpty() }
      if (allBuffers(test).any { line -> markers.any { line.contains(it) } }) {
        return "marker folding (foldmethod=marker) isn't available in IdeaVim"
      }
    }

    // Line wrapping: IntelliJ's soft wraps break at word boundaries and leave room for the wrap sign, so screen lines
    // don't match Vim's 'wrap'. Run window-dependent tests only if no line is long enough to wrap. A test that sets
    // 'textwidth' has a window of the same width only to keep the two consistent; IdeaVim formats to its own
    // 'textwidth' option, so such a test doesn't depend on how lines wrap on screen.
    if (test["windowSpecified"] == true && options["wrap"] == true) {
      val width = test.obj("window").int("width")
      val tabstop = options["tabstop"].asInt()
      if (options["textwidth"].asInt() != width && allBuffers(test).any { displayWidth(it, tabstop) >= width - 1 }) {
        return "depends on line wrapping, which IntelliJ's soft wraps can't reproduce at Vim's columns"
      }
    }
    return null
  }

  private fun allBuffers(test: Map<String, Any?>): List<String> =
    test.obj("initial").arr("lines").map { it as String } +
      test.arr("steps").flatMap { (it as Map<String, Any?>).obj("expected").arr("lines").map { line -> line as String } }

  private fun applyCodeStyle(options: Map<String, Any?>) {
    val tabstop = options["tabstop"].asInt()
    val shiftwidth = options["shiftwidth"].asInt().let { if (it == 0) tabstop else it }
    val settings = CodeStyle.createTestSettings()
    val indentOptions = settings.getIndentOptions(PlainTextFileType.INSTANCE)
    indentOptions.TAB_SIZE = tabstop
    indentOptions.INDENT_SIZE = shiftwidth
    indentOptions.USE_TAB_CHARACTER = options["expandtab"] != true
    indentOptions.SMART_TABS = false
    CodeStyle.setTemporarySettings(fixture.project, settings)
    temporaryCodeStyle = true
  }

  /** Sets the IdeaVim options, as `:set` would (local and global values). Skips the test if IdeaVim rejects a value. */
  private fun applyVimOptions(options: Map<String, Any?>) {
    val vimEditor = fixture.editor.vim
    for (name in VIM_OPTIONS) {
      if (name !in options) continue
      var value = options[name]
      if (name == "nrformats") {
        // IdeaVim doesn't support binary numbers, so 'nrformats' has no "bin" value. Leave it out and run the test.
        value = (value as String).split(',').filter { it.isNotEmpty() && it != "bin" }.joinToString(",")
      }
      val option = injector.optionGroup.getOption(name) ?: throw SkipTest("IdeaVim has no '$name' option")
      val token = "$name=${formatValue(value)}"
      try {
        val vimValue: VimDataType = if (option is ToggleOption) {
          if (value == true) VimInt.ONE else VimInt.ZERO
        } else {
          option.parseValue(formatValue(value), token)
        }
        injector.optionGroup.setOptionValue(option, OptionAccessScope.EFFECTIVE(vimEditor), vimValue)
      } catch (e: Exception) {
        throw SkipTest("IdeaVim rejects $token: ${e.message}")
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Keys

  /** The key strokes for one vim-unit key token. */
  private fun keyStrokes(token: String): List<KeyStroke> {
    if (token.length > 2 && token.startsWith("<") && token.endsWith(">")) {
      // IdeaVim's notation lacks <Nul>; <C-@> is the same key.
      val notation = if (token.equals("<Nul>", ignoreCase = true)) "<C-@>" else token
      val parsed = injector.parser.parseKeys(notation)
      require(parsed.size == 1) { "IdeaVim parses $token as ${parsed.size} keys" }
      return parsed
    }
    // A character. One outside the BMP is a surrogate pair, which the IDE delivers as two typed characters.
    return token.map { c ->
      when {
        // Control characters are key presses, as IdeaVim's own key parser treats them
        c == '\t' -> KeyStroke.getKeyStroke(KeyEvent.VK_TAB, 0)
        c == '\n' -> KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, 0)
        c.code < 0x20 -> KeyStroke.getKeyStroke(c.code + 'A'.code - 1, java.awt.event.InputEvent.CTRL_DOWN_MASK)
        else -> KeyStroke.getKeyStroke(c)
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Results

  private val errorRecorder = object : LoggedErrorProcessor() {
    override fun processError(category: String, message: String, details: Array<out String>, t: Throwable?): Set<Action> {
      // In the IDE, LOG.error only logs. In tests it throws, which would abort the step.
      diagnostic("IdeaVim logged an error: $message${t?.let { "\n" + it.stackTraceToString() } ?: ""}")
      return EnumSet.noneOf(Action::class.java)
    }
  }

  private fun diagnostic(message: String) {
    val dir = suite?.dir ?: return
    synchronized(Companion) {
      File(dir, "diagnostics.log").appendText("[$currentId, step $currentStep] $message\n", Charsets.UTF_8)
    }
  }

  private fun writeResult(line: String) {
    synchronized(Companion) {
      File(suite!!.dir, "results.jsonl").appendText(line + "\n", Charsets.UTF_8)
    }
  }

  private fun stateLine(id: String, step: Int, state: BufferState): String =
    "{\"id\": ${jsonString(id)}, \"step\": $step, \"lines\": [" +
      state.lines.joinToString(", ") { jsonString(it) } +
      "], \"cursor\": [${state.line}, ${state.column}], \"unit\": \"utf16\"}"

  private fun skipLine(id: String, step: Int, reason: String): String =
    "{\"id\": ${jsonString(id)}, \"step\": $step, \"skipped\": ${jsonString(reason)}}"

  private fun errorLine(id: String, step: Int, message: String): String =
    "{\"id\": ${jsonString(id)}, \"step\": $step, \"error\": ${jsonString(message)}}"

  // ------------------------------------------------------------------------------------------------------------------

  private class Suite(val dir: File, val baselineOptions: Map<String, Any?>, val tests: List<Map<String, Any?>>)

  companion object {
    /** vim-unit options that IdeaVim implements as options of its own. */
    private val VIM_OPTIONS = listOf(
      "wrap", "breakindent", "scrolloff", "sidescroll", "sidescrolloff", "scrolljump", "scroll", "startofline",
      "autoindent", "textwidth", "comments", "nrformats", "whichwrap", "virtualedit", "selection", "selectmode",
      "keymodel", "iskeyword", "matchpairs", "undolevels", "ignorecase", "smartcase", "wrapscan", "gdefault",
      "incsearch", "foldlevel",
    )

    /** vim-unit options that are IntelliJ code style settings, applied by [applyCodeStyle]. */
    private val CODE_STYLE_OPTIONS = setOf("tabstop", "shiftwidth", "expandtab")

    /**
     * For options IdeaVim doesn't have, the value its fixed behaviour corresponds to, where that isn't the baseline.
     * Tests that set such an option to any other value are skipped.
     */
    private val FIXED_OPTION_VALUES = mapOf<String, Any?>("foldmethod" to "manual")

    private val FIXTURE_MARKUP = listOf("<caret>", "<selection>", "</selection>", "<block>", "</block>")

    private val suite: Suite? by lazy { loadSuite() }

    private fun loadSuite(): Suite? {
      val dir = findDataDir() ?: return null
      val export = JsonReader(File(dir, "tests.json").readText(Charsets.UTF_8)).parse() as Map<String, Any?>
      require(export["schemaVersion"].asInt() == 1) { "unsupported vim-unit schemaVersion ${export["schemaVersion"]}" }
      return Suite(dir, export.obj("baselineOptions"), export.arr("tests").map { it as Map<String, Any?> })
    }

    private fun findDataDir(): File? {
      (System.getProperty("vimunit.dir") ?: System.getenv("VIMUNIT_DIR"))?.let { return File(it) }
      val starts = listOfNotNull(
        System.getProperty("user.dir")?.let(::File),
        runCatching { File(VimUnitSuiteTest::class.java.protectionDomain.codeSource.location.toURI()) }.getOrNull(),
      )
      for (start in starts) {
        var dir: File? = start.absoluteFile
        while (dir != null) {
          val candidate = File(dir, "build/vimunit")
          if (File(candidate, "tests.json").isFile) return candidate
          dir = dir.parentFile
        }
      }
      return null
    }

    @JvmStatic
    fun vimUnitTests(): List<Arguments> {
      val suite = suite ?: return listOf(Arguments.of("vim-unit suite not exported", -1))
      return suite.tests.mapIndexed { i, test -> Arguments.of(test.str("id"), i) }
    }

    private fun offsetOf(lines: List<String>, line: Int, column: Int): Int {
      var offset = 0
      for (i in 0 until line) offset += lines[i].length + 1
      return offset + column
    }

    private fun formatValue(value: Any?): String = when (value) {
      true -> "on"
      false -> "off"
      null -> "(none)"
      else -> value.toString()
    }

    /** Screen columns taken by a line in Vim, for deciding whether it could wrap. Errs on the wide side. */
    private fun displayWidth(line: String, tabstop: Int): Int {
      var col = 0
      var i = 0
      while (i < line.length) {
        val cp = line.codePointAt(i)
        i += Character.charCount(cp)
        val type = Character.getType(cp)
        col += when {
          cp == '\t'.code -> tabstop - col % tabstop
          type == Character.NON_SPACING_MARK.toInt() || type == Character.ENCLOSING_MARK.toInt() -> 0
          isWide(cp) -> 2
          else -> 1
        }
      }
      return col
    }

    private fun isWide(cp: Int): Boolean =
      cp in 0x1100..0x115F || cp in 0x2E80..0xA4CF || cp in 0xAC00..0xD7A3 || cp in 0xF900..0xFAFF ||
        cp in 0xFE30..0xFE4F || cp in 0xFF00..0xFF60 || cp in 0xFFE0..0xFFE6 || cp in 0x1F000..0x1FAFF ||
        cp in 0x20000..0x3FFFD

    private fun jsonString(s: String): String = buildString {
      append('"')
      for (c in s) {
        when {
          c == '"' -> append("\\\"")
          c == '\\' -> append("\\\\")
          c == '\n' -> append("\\n")
          c == '\r' -> append("\\r")
          c == '\t' -> append("\\t")
          // Escape surrogates so that an unpaired one (a split character) survives the trip through UTF-8
          c.code < 0x20 || c.code == 0x7F || c.isSurrogate() -> append(String.format("\\u%04x", c.code))
          else -> append(c)
        }
      }
      append('"')
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------------
// A small JSON reader, so that the adapter doesn't depend on which JSON library the test classpath happens to have.

private class JsonReader(private val s: String) {
  private var i = 0

  fun parse(): Any? {
    val value = value()
    skipWhitespace()
    require(i == s.length) { "trailing characters at offset $i" }
    return value
  }

  private fun skipWhitespace() {
    while (i < s.length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++
  }

  private fun value(): Any? {
    skipWhitespace()
    require(i < s.length) { "unexpected end of JSON" }
    return when (s[i]) {
      '{' -> obj()
      '[' -> arr()
      '"' -> str()
      't' -> literal("true", true)
      'f' -> literal("false", false)
      'n' -> literal("null", null)
      else -> number()
    }
  }

  private fun literal(word: String, value: Any?): Any? {
    require(s.startsWith(word, i)) { "bad literal at offset $i" }
    i += word.length
    return value
  }

  private fun expect(c: Char) {
    require(i < s.length && s[i] == c) { "expected '$c' at offset $i" }
    i++
  }

  private fun obj(): Map<String, Any?> {
    expect('{')
    val result = LinkedHashMap<String, Any?>()
    skipWhitespace()
    if (i < s.length && s[i] == '}') {
      i++
      return result
    }
    while (true) {
      skipWhitespace()
      val key = str()
      skipWhitespace()
      expect(':')
      result[key] = value()
      skipWhitespace()
      require(i < s.length) { "unexpected end of JSON" }
      when (s[i++]) {
        ',' -> continue
        '}' -> return result
        else -> throw IllegalArgumentException("expected ',' or '}' at offset ${i - 1}")
      }
    }
  }

  private fun arr(): List<Any?> {
    expect('[')
    val result = ArrayList<Any?>()
    skipWhitespace()
    if (i < s.length && s[i] == ']') {
      i++
      return result
    }
    while (true) {
      result.add(value())
      skipWhitespace()
      require(i < s.length) { "unexpected end of JSON" }
      when (s[i++]) {
        ',' -> continue
        ']' -> return result
        else -> throw IllegalArgumentException("expected ',' or ']' at offset ${i - 1}")
      }
    }
  }

  private fun str(): String {
    expect('"')
    val sb = StringBuilder()
    while (true) {
      require(i < s.length) { "unterminated string" }
      val c = s[i++]
      when (c) {
        '"' -> return sb.toString()
        '\\' -> {
          val e = s[i++]
          when (e) {
            '"' -> sb.append('"')
            '\\' -> sb.append('\\')
            '/' -> sb.append('/')
            'b' -> sb.append('\b')
            'f' -> sb.append('\u000C')
            'n' -> sb.append('\n')
            'r' -> sb.append('\r')
            't' -> sb.append('\t')
            'u' -> {
              sb.append(s.substring(i, i + 4).toInt(16).toChar())
              i += 4
            }
            else -> throw IllegalArgumentException("bad escape '\\$e' at offset ${i - 1}")
          }
        }
        else -> sb.append(c)
      }
    }
  }

  private fun number(): Any {
    val start = i
    while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
    val text = s.substring(start, i)
    require(text.isNotEmpty()) { "unexpected character '${s.getOrNull(i)}' at offset $i" }
    return text.toLongOrNull() ?: text.toDouble()
  }
}

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.obj(key: String): Map<String, Any?> = this[key] as Map<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.arr(key: String): List<Any?> = this[key] as List<Any?>

private fun Map<String, Any?>.str(key: String): String = this[key] as String

private fun Map<String, Any?>.int(key: String): Int = (this[key] as Number).toInt()

private fun Any?.asInt(): Int = (this as Number).toInt()
