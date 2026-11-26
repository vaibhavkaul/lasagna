import {useKeyboard, usePaste} from '@opentui/react';
import {textAttributes, terminalColor, dimText} from '../tui-style.ts';
import {Fragment, useState, useMemo, useRef} from 'react';

import TextInput from './TextInput.tsx';
import TitledBox from './TitledBox.tsx';
import ConfirmDialog from './ConfirmDialog.tsx';
import {resolveEmojiSlot} from '../emoji-rail-width.ts';
import {maybeStripSkinTones, useTmuxSkinToneWide} from '../tmux-skin-tone.ts';
import {
	determineProfileForInput,
	exampleIssueKeys,
	listAgentProfiles,
	loadAgentProfileSources,
	resolveAgentProfileName,
	type PappardelleConfig,
	type ProfileSelection,
} from '../config.ts';
import {inlineConfigErrors} from '../config-errors.ts';
import {readReportedConfig} from '../config-report.ts';
import {truncateToWidth} from '../truncate-to-width.ts';
import {useWidthMethod} from './use-width-method.ts';
import {createIssueTracker, issueTrackerFor} from '../providers/index.ts';
import type {RepoContext} from '../repo-context.ts';
import type {IssueTrackerProvider} from '../providers/types.ts';
import {
	applySkillCompletion,
	clampSelection,
	reanchorSelection,
	handleSkillListKey,
	handleSkillPickerKey,
	matchSkills,
	skillQuery,
	skillTokenLength,
	SKILL_PICKER_MAX_VISIBLE,
	type SkillEntry,
} from '../skill-completion.ts';
import {
	pickerOptions,
	computePickerWindow,
	filterProfileOptions,
	focusFrame,
	handleFilterablePickerKey,
	pasteIntoFilterablePicker,
	resolvePromptSubmit,
	PICKER_MAX_VISIBLE,
	type FilterablePickerState,
	type ProfileOption,
} from '../profile-picker.ts';
import {useSkillSnapshot} from '../use-skill-snapshot.ts';
import {pickAgentProfileInPopup} from '../popup/agent-profile.ts';
import {cutAgentProfileName} from '../agent-profile-picker.ts';
import {ReadyWorkList, useReadyWork} from './ReadyWork.tsx';
import {INPUT_INDEX, resolveSubmission} from './ready-picker.ts';
import {promptDialogLayout} from './prompt-dialog-layout.ts';
import RepoPicker from './RepoPicker.tsx';
import type {RepoChoices} from '../repo-picker.ts';

/** React key for the profile-less row, which has no profile name to use. */
const DEFERRED_ROW_KEY = '__deferred__';

function rowKey(option: ProfileOption): string {
	return option.name ?? DEFERRED_ROW_KEY;
}

/** The parts of a repo the dialog reads. */
export type DialogRepo = Pick<
	RepoContext,
	'name' | 'readConfig' | 'configPaths'
>;

/** The repos a space can be made in, on a rail that shows a whole work dir. */
export type RepoField = {
	/**
	 * The repos to offer for what is typed, the ones its issue key is worked
	 * on in first, and the one the space goes in unless another is picked.
	 */
	choicesFor: (input: string) => RepoChoices;
	contextOf: (name: string) => DialogRepo | undefined;
};

interface Props {
	onSubmit: (
		prompt: string,
		profileName: string | null,
		inputIsIssueKey: boolean,
		agentProfileName: string | null,
		/** The repos the space is made in, when the dialog offers a choice. */
		repos?: string[],
	) => void;
	onCancel: () => void;
	/** The profile a space was saved with, for input that names one. */
	savedProfileFor?: (
		input: string,
		config: PappardelleConfig | null,
		/** The repo the space would be made in, where the dialog offers a choice. */
		repo?: string,
	) => string | undefined;
	/**
	 * Columns available to the dialog, which ready-work rows truncate their
	 * titles to. The frames themselves stretch to the pane.
	 */
	availableWidth: number;
	/** Rows available to the dialog, which drops to a compact layout to fit. */
	availableHeight?: number;
	/** The agent profile popup is a tmux popup, so the override needs tmux. */
	isInTmux: boolean;
	/**
	 * The repo the space is made in, on a rail that shows more than one: its
	 * config, profiles and tracker are the dialog's. Unset for the repo the TUI
	 * runs in.
	 */
	repo?: DialogRepo;
	/**
	 * Set in place of `repo` when the space can be made in any of several: the
	 * dialog starts on the one the typed issue key belongs in, Tab lists them
	 * all, and more than one can be picked.
	 */
	repos?: RepoField;
}

export default function PromptDialog({
	onSubmit,
	onCancel,
	savedProfileFor,
	availableWidth,
	availableHeight,
	isInTmux,
	repo: fixedRepo,
	repos,
}: Props) {
	const [prompt, setPrompt] = useState('');
	// The repos picked from the list. Until one is, the repo follows what is
	// typed: an issue key's own repo, else the one last worked in.
	const [pickedRepos, setPickedRepos] = useState<string[] | null>(null);
	const [repoStage, setRepoStage] = useState<'closed' | 'open' | 'confirming'>(
		'closed',
	);
	// The repos confirmed for one ready row. They are that row's alone: the
	// list stays its tracker's, and another row or typed text is asked afresh.
	const [rowRepos, setRowRepos] = useState<{
		key: string;
		names: string[];
	} | null>(null);
	const typedChoices = useMemo(
		() => repos?.choicesFor(prompt),
		[repos, prompt],
	);
	const typedRepo = typedChoices?.rows[typedChoices.defaultIndex]?.name;
	// Whose config, profiles and tracker the dialog reads for these repos.
	const contextFor = (names: readonly string[]) =>
		repos
			? names[0] === undefined
				? undefined
				: repos.contextOf(names[0])
			: fixedRepo;
	// The repo whose tracker lists the ready work: the one typed text or a pick
	// names. A highlighted row does not move it, or the list would change
	// under the cursor that is on it.
	const listRepo = useMemo(
		() =>
			contextFor(pickedRepos ?? (typedRepo === undefined ? [] : [typedRepo])),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[repos, pickedRepos, typedRepo, fixedRepo],
	);
	// Both boxes are always on screen; this is purely which one has focus.
	const [isPicking, setIsPicking] = useState(false);
	const [pickerState, setPickerState] = useState<FilterablePickerState>({
		query: null,
		index: 0,
	});
	// Keyed by row so an override stays with its profile while the list
	// re-ranks under further typing.
	const [agentOverrides, setAgentOverrides] = useState<Record<string, string>>(
		{},
	);

	// Escape closes the completion list without clearing what you typed, so the
	// dismissal has to be remembered against the exact text it was made for:
	// the next keystroke is a new query and deserves a fresh list.
	const [dismissedFor, setDismissedFor] = useState<string | null>(null);
	const [completionIndex, setCompletionIndex] = useState(0);
	// Enter moves the focus into the Skills box, which freezes the text input
	// and buys back `j`/`k` and Enter itself. Tab never needs this: it accepts
	// from wherever you are.
	const [isPickingSkill, setIsPickingSkill] = useState(false);

	// Resolved once. `createIssueTracker` throws when no provider is configured,
	// and every capability the dialog gates on — ready listing, closing — is a
	// question about this one object, so it is the only place that has to ask.
	const tracker = useMemo((): IssueTrackerProvider | null => {
		try {
			return listRepo ? issueTrackerFor(listRepo.name) : createIssueTracker();
		} catch {
			return null;
		}
	}, [listRepo]);

	const skills = useSkillSnapshot();

	const query = skillQuery(prompt);
	const completions = useMemo(
		() => (query === null ? [] : matchSkills(skills, query)),
		[skills, query],
	);
	const seenSkills = useRef(skills);
	const highlightedName = useRef<string | undefined>(undefined);
	// Keys that arrive with `a` in one write (a paste, a slow SSH link) would
	// otherwise move or start the picker behind the popup.
	const agentPopupOpen = useRef(false);
	if (seenSkills.current !== skills) {
		seenSkills.current = skills;
		const anchored = reanchorSelection(highlightedName.current, completions);
		if (anchored !== completionIndex) setCompletionIndex(anchored);
	}

	// Cyan, the Skills box's own color, so a painted name reads as "this is one
	// of those". Survives the space that closes the list, which is the point:
	// past that space the list is gone and the color is the only confirmation
	// left that the name is real.
	const highlight = useMemo(
		() => ({length: skillTokenLength(prompt, skills), color: 'cyan' as const}),
		[prompt, skills],
	);

	const isCompleting =
		!isPicking &&
		query !== null &&
		completions.length > 0 &&
		dismissedFor !== prompt;
	// Derived, never trusted from state alone: if the list closed underneath a
	// focused picker the focus has nowhere to be, and the prompt takes it back.
	const isSkillFocused = isCompleting && isPickingSkill;

	const acceptCompletion = (index: number) => {
		const chosen = completions[clampSelection(index, completions.length)];
		if (!chosen) return;
		setPrompt(applySkillCompletion(chosen.name));
		setCompletionIndex(0);
		// The accepted text ends in a space, so the list is already closed by the
		// time this renders; the focus has to come home with it.
		setIsPickingSkill(false);
	};

	const ready = useReadyWork(
		tracker,
		!isPicking && !isCompleting && !isSkillFocused && repoStage === 'closed',
	);
	const effectiveInput =
		resolveSubmission(prompt, ready.identifiers, ready.index) ?? '';

	// A highlighted ready row is an issue key as much as a typed one, so its
	// prefix says which repos it belongs in. A row whose prefix nothing knows
	// stays in the repo whose tracker listed it.
	const choices = useMemo(() => {
		if (!repos || !ready.onRow) return typedChoices;
		const forRow = repos.choicesFor(effectiveInput);
		return forRow.rows.some(row => row.suggested) ? forRow : typedChoices;
	}, [repos, ready.onRow, effectiveInput, typedChoices]);
	const suggestedRepo = choices?.rows[choices.defaultIndex]?.name;
	const chosenRepos = useMemo(
		() =>
			pickedRepos ??
			(ready.onRow && rowRepos?.key === effectiveInput
				? rowRepos.names
				: suggestedRepo === undefined
					? []
					: [suggestedRepo]),
		[pickedRepos, ready.onRow, rowRepos, effectiveInput, suggestedRepo],
	);
	const leadRepo = chosenRepos[0];
	const repo = useMemo(
		() => contextFor(chosenRepos),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[repos, chosenRepos, fixedRepo],
	);

	// Load config once
	const configLoad = useMemo(
		() => (repo ? repo.readConfig() : readReportedConfig()),
		[repo],
	);
	const config = configLoad.kind === 'valid' ? configLoad.config : null;
	const exampleKeys = useMemo(
		() => (config ? exampleIssueKeys(config) : ['STA-123', '123']),
		[config],
	);
	const placeholder = useMemo(
		() =>
			`${new Intl.ListFormat('en', {type: 'disjunction'}).format([...exampleKeys, 'describe the task'])}...`,
		[exampleKeys],
	);

	const widthMethod = useWidthMethod();
	const errorMessage =
		configLoad.kind === 'invalid'
			? truncateToWidth(
					`Fix .pappardelle.yml to create a space: ${inlineConfigErrors(configLoad.errors)}`,
					availableWidth - 6,
					widthMethod,
				)
			: ready.errorMessage;
	// The close confirmation takes over the whole dialog, so every other keymap
	// stands down while it is up.
	const isPromptStage =
		!isPicking && ready.closeTarget === null && repoStage === 'closed';

	// Live preview of what the first Enter will do. Deferred inputs (issue keys)
	// still say so and still spawn on that one Enter; everything else advertises
	// the profile the picker will preselect.
	const preview = useMemo((): ProfileSelection | null => {
		if (!config) return null;
		return determineProfileForInput(config, effectiveInput);
	}, [config, effectiveInput]);
	const canOverrideAgent = useMemo(
		() =>
			isInTmux && config !== null && listAgentProfiles(config, {}).length > 1,
		[config, isInTmux],
	);
	const opensPicker =
		preview?.kind === 'resolved' ||
		(preview?.kind === 'deferred' && (preview.canPick || canOverrideAgent));

	// Derived from the current prompt rather than snapshotted on Enter, because
	// the list is visible while you type and has to re-rank as you go. Once the
	// picker takes focus the text input is frozen, so the list is stable for as
	// long as a selection can move within it.
	const options = useMemo(
		() =>
			config
				? pickerOptions(
						config,
						effectiveInput,
						canOverrideAgent,
						savedProfileFor?.(effectiveInput, config, repo?.name),
					)
				: [],
		[config, effectiveInput, canOverrideAgent, savedProfileFor, repo],
	);

	const shownOptions =
		isPicking && pickerState.query
			? filterProfileOptions(options, pickerState.query)
			: options;

	// While typing, the preselected row IS the answer the old "Profile:" line
	// used to spell out, so it always tracks the top of the list; the stored
	// index only matters once the picker has focus.
	const activeIndex = isPicking ? pickerState.index : 0;

	useKeyboard(event => {
		if (!(isPromptStage && !isSkillFocused)) return;
		if (event.name !== 'escape') return;
		// First Esc dismisses the completion list; a second one (now that the
		// list is gone) cancels the dialog. Mirrors the profile picker's
		// two-stage Esc so the key never means two things at once.
		if (isCompleting) {
			setDismissedFor(prompt);
			setCompletionIndex(0);
			return;
		}
		onCancel();
	});

	// Tab lists the repos, when there is nothing for it to complete.
	useKeyboard(event => {
		if (!repos || !isPromptStage || isSkillFocused || isCompleting) return;
		if (event.name === 'tab') setRepoStage('open');
	});

	// Arrows and Tab. The text input keeps focus while the list is open, so
	// every printable key still has to reach it.
	useKeyboard(event => {
		if (!(isCompleting && !isSkillFocused)) return;
		const result = handleSkillPickerKey(
			event,
			completionIndex,
			completions.length,
		);
		if (result.action === 'move') {
			setCompletionIndex(result.index);
		} else if (result.action === 'accept') {
			acceptCompletion(result.index);
		}
	});

	// The same list once it has the focus. The text input is frozen here, so
	// this map can afford `j`/`k` and Enter.
	useKeyboard(event => {
		if (!isSkillFocused) return;
		const result = handleSkillListKey(
			event,
			completionIndex,
			completions.length,
		);
		switch (result.action) {
			case 'move': {
				setCompletionIndex(result.index);
				break;
			}

			case 'accept': {
				acceptCompletion(result.index);
				break;
			}

			case 'back': {
				// The list stays open; only the focus goes back. The Esc after this
				// one dismisses the list, and the one after that cancels the dialog.
				setIsPickingSkill(false);
				break;
			}

			case 'ignore': {
				break;
			}
		}
	});

	usePaste(event => {
		if (!(isPicking && ready.closeTarget === null)) return;
		if (agentPopupOpen.current) return;
		setPickerState(
			pasteIntoFilterablePicker(
				pickerState,
				new TextDecoder().decode(event.bytes),
			),
		);
	});

	useKeyboard(event => {
		if (!(isPicking && ready.closeTarget === null)) return;
		if (agentPopupOpen.current) return;
		const shown = pickerState.query
			? filterProfileOptions(options, pickerState.query)
			: options;
		const result = handleFilterablePickerKey(pickerState, event, shown.length);
		setPickerState(result.state);
		switch (result.action) {
			case 'submit': {
				const chosen = shown[result.state.index];
				if (chosen) {
					onSubmit(
						effectiveInput.trim(),
						chosen.name,
						ready.onRow,
						agentOverrides[rowKey(chosen)] ?? null,
						repos ? chosenRepos : undefined,
					);
				}

				break;
			}

			case 'select': {
				// Back to the full list with the match highlighted, so starting the
				// session (or `a`) is still its own keystroke.
				const chosen = shown[result.state.index];
				setPickerState({
					query: null,
					index: chosen ? Math.max(0, options.indexOf(chosen)) : 0,
				});
				break;
			}

			case 'agent': {
				const option = shown[result.state.index];
				if (option && config && canOverrideAgent) {
					void chooseAgentProfile(option, config);
				}
				break;
			}

			case 'back': {
				// First Esc hands focus back to the prompt; a second one (handled by
				// the other useInput, now re-armed) cancels the dialog.
				setIsPicking(false);
				setPickerState({query: null, index: 0});
				break;
			}

			case undefined: {
				break;
			}
		}
	});

	const chooseAgentProfile = async (
		option: ProfileOption,
		loadedConfig: PappardelleConfig,
	) => {
		const key = rowKey(option);
		const agentProfiles = listAgentProfiles(
			loadedConfig,
			loadAgentProfileSources(repo?.configPaths()),
		);
		// The deferred row's profile isn't known until idow fetches the issue, so
		// it gets a row of its own, named '', that leaves the choice to idow.
		const profileDefault =
			option.kind === 'profile'
				? resolveAgentProfileName(
						loadedConfig,
						undefined,
						option.name ?? undefined,
					)
				: '';
		agentPopupOpen.current = true;
		const name = await pickAgentProfileInPopup({
			options:
				option.kind === 'profile'
					? agentProfiles
					: [
							{name: '', source: "whichever the issue's profile uses"},
							...agentProfiles,
						],
			selected: agentOverrides[key] ?? profileDefault,
			profileDefault,
		}).finally(() => {
			agentPopupOpen.current = false;
		});
		if (name === null) return;
		setAgentOverrides(current => {
			const {[key]: _previous, ...rest} = current;
			return name === profileDefault ? rest : {...rest, [key]: name};
		});
	};

	// The list re-ranks on every keystroke, so an index parked deep in a long
	// list would point past the end of a short one. Rendering and acceptance
	// both read this, or Enter highlights one row and accepts nothing.
	const activeCompletion = clampSelection(completionIndex, completions.length);
	highlightedName.current = completions[activeCompletion]?.name;

	const handlePromptSubmit = (value: string) => {
		// Enter belongs to the completion list while it is open, but only to move
		// the focus there. Tab is what accepts. This way one Enter never both
		// rewrites the prompt and leaves you unsure what the next Enter will do.
		if (isCompleting) {
			setIsPickingSkill(true);
			return;
		}

		const resolved = resolveSubmission(value, ready.identifiers, ready.index);
		if (resolved === null) return;

		// A key worked on in several repos is asked about once, on the repo its
		// prefix defaults to, whether it was typed or is a ready row's.
		if (
			pickedRepos === null &&
			!(ready.onRow && rowRepos?.key === resolved) &&
			(choices?.rows.filter(row => row.suggested).length ?? 0) > 1
		) {
			setRepoStage('confirming');
			return;
		}

		startOrPick(resolved, chosenRepos, configLoad, canOverrideAgent);
	};

	/** What Enter does once the repos are settled: start, or go to the profiles. */
	const startOrPick = (
		resolved: string,
		names: readonly string[],
		load: typeof configLoad,
		canOverride: boolean,
	) => {
		const decision = resolvePromptSubmit(load, resolved, canOverride);
		switch (decision.kind) {
			case 'none': {
				break;
			}

			case 'spawn': {
				onSubmit(
					resolved,
					decision.profileName,
					ready.onRow,
					null,
					repos ? [...names] : undefined,
				);
				break;
			}

			case 'pick': {
				setIsPicking(true);
				setPickerState({query: null, index: 0});
				break;
			}
		}
	};

	/**
	 * The repos picked from the list. When Enter asked for the list, the same
	 * Enter carries on, with the config of the repos just picked: the dialog
	 * has not been drawn for them yet.
	 */
	const pickRepos = (names: string[]) => {
		const wasConfirming = repoStage === 'confirming';
		const resolved = resolveSubmission(prompt, ready.identifiers, ready.index);
		setRepoStage('closed');
		// Repos confirmed for a ready row are that row's: picking them for the
		// whole dialog would swap the list for another tracker's while the
		// cursor is on one of its rows.
		if (wasConfirming && ready.onRow && resolved !== null)
			setRowRepos({key: resolved, names});
		else setPickedRepos(names);
		if (!wasConfirming || resolved === null) return;
		const picked = contextFor(names);
		const load = picked ? picked.readConfig() : configLoad;
		startOrPick(
			resolved,
			names,
			load,
			isInTmux &&
				load.kind === 'valid' &&
				listAgentProfiles(load.config, {}).length > 1,
		);
	};

	if (repoStage !== 'closed' && choices) {
		return (
			<RepoPicker
				repos={choices.rows}
				initialIndex={Math.max(
					0,
					choices.rows.findIndex(row => row.name === leadRepo),
				)}
				initialTicked={chosenRepos.length > 1 ? chosenRepos : undefined}
				prefix={choices.prefix}
				availableHeight={availableHeight}
				onPick={pickRepos}
				onCancel={() => setRepoStage('closed')}
			/>
		);
	}

	if (ready.closeTarget) {
		const {identifier, title} = ready.closeTarget.issue;
		return (
			<ConfirmDialog
				title="Close Issue"
				message={`Close ${identifier}?`}
				detail={title}
				processingMessage={`Closing ${identifier}…`}
				isDestructive={false}
				onConfirm={ready.confirmClose}
				onCancel={ready.cancelClose}
			/>
		);
	}

	// The heavy outline is the only thing saying where a keystroke lands, so the
	// prompt gives it up to whichever picker took the focus from it.
	const promptFrame = focusFrame(
		!isPicking && !isSkillFocused && ready.index === INPUT_INDEX,
	);
	const pickerFrame = focusFrame(isPicking);
	// With an agent to swap in, pickerOptions gives the deferred input a real
	// row so `a` has something to act on.
	const deferredLabel =
		configLoad.kind === 'invalid'
			? 'No profiles until .pappardelle.yml is fixed'
			: preview?.kind === 'deferred' && !preview.canPick && !canOverrideAgent
				? preview.displayName
				: undefined;
	const layout = promptDialogLayout(
		availableHeight,
		isCompleting ? SKILL_PICKER_MAX_VISIBLE : PICKER_MAX_VISIBLE,
		{
			readyCount: ready.issues.length,
			isReadyLoading: ready.loading,
			hasError: errorMessage !== null,
			pickerCount: isCompleting
				? completions.length
				: deferredLabel
					? 1
					: options.length,
		},
	);

	return (
		<box flexDirection="column">
			<TitledBox
				title={
					chosenRepos.length > 1
						? `+ New Ticket Space in ${chosenRepos.join(' + ')}`
						: repo
							? `+ New Session in ${repo.name}`
							: '+ New Session'
				}
				borderColor="green"
				titleColor="greenBright"
				borderStyle={promptFrame.borderStyle}
				isDim={promptFrame.isDim}
				paddingY={layout.paddingY}
			>
				<box
					marginBottom={1}
					flexDirection="column"
					visible={layout.showInstructions}
				>
					<text {...dimText()}>Enter a prompt or issue key:</text>
					<text {...dimText()}>
						-{' '}
						{exampleKeys.map((key, index) => (
							<Fragment key={key}>
								{index > 0 && ' or '}
								<span fg={terminalColor('cyan')}>{key}</span>
							</Fragment>
						))}{' '}
						= open workspace for existing issue
					</text>
					<text {...dimText()}>
						- <span fg={terminalColor('cyan')}>description</span> = start new
						workspace
					</text>
				</box>

				<box flexDirection="row">
					<text flexShrink={1} fg={terminalColor('cyan')}>
						&gt;{' '}
					</text>
					<TextInput
						isMultiline
						value={prompt}
						onChange={setPrompt}
						onSubmit={handlePromptSubmit}
						placeholder={placeholder}
						isFocused={!isPicking && !isSkillFocused}
						isShowingCursor={ready.index === INPUT_INDEX}
						highlight={highlight}
						isKeepingVerticalArrows={!isCompleting && ready.issues.length === 0}
					/>
				</box>

				{errorMessage && (
					<box flexDirection="row" marginTop={1}>
						<text flexShrink={1} fg={terminalColor('red')}>
							{errorMessage}
						</text>
					</box>
				)}

				{!isPicking && !isSkillFocused && (
					<box flexDirection="row" marginTop={1}>
						<text {...dimText()}>
							{isCompleting ? (
								<>
									Press <span fg={terminalColor('cyan')}>Tab</span> to complete,{' '}
									<span fg={terminalColor('green')}>Enter</span> for the list,{' '}
									<span fg={terminalColor('yellow')}>Esc</span> to dismiss
								</>
							) : (
								<>
									Press <span fg={terminalColor('green')}>Enter</span> to{' '}
									{opensPicker
										? preview?.kind === 'deferred' && !preview.canPick
											? 'start or pick an agent'
											: 'choose a profile'
										: 'start'}
									{repos ? (
										<>
											, <span fg={terminalColor('cyan')}>Tab</span> for repos
										</>
									) : null}
									, <span fg={terminalColor('yellow')}>Esc</span> to cancel
								</>
							)}
						</text>
					</box>
				)}
			</TitledBox>

			<ReadyWorkList
				ready={ready}
				width={availableWidth}
				isFocused={!isPicking && ready.index >= 0}
				hasHints={!isPicking}
				maxVisible={layout.readyMaxVisible}
			/>
			{isCompleting ? (
				<SkillPicker
					entries={completions}
					selectedIndex={activeCompletion}
					frame={focusFrame(isSkillFocused)}
					isFocused={isSkillFocused}
					maxVisible={layout.pickerMaxVisible}
				/>
			) : (
				<ProfilePicker
					options={shownOptions}
					query={isPicking ? pickerState.query : null}
					agentOverrides={agentOverrides}
					selectedIndex={activeIndex}
					frame={pickerFrame}
					isFocused={isPicking}
					deferredLabel={deferredLabel}
					hasAgentChoice={canOverrideAgent}
					maxVisible={layout.pickerMaxVisible}
				/>
			)}
		</box>
	);
}

function ProfilePicker({
	options,
	query,
	agentOverrides,
	selectedIndex,
	frame,
	isFocused,
	deferredLabel,
	hasAgentChoice,
	maxVisible,
}: {
	options: ProfileOption[];
	/** The `/` filter's text, null when not filtering. */
	query: string | null;
	agentOverrides: Record<string, string>;
	selectedIndex: number;
	frame: {borderStyle: 'double' | 'round'; isDim: boolean};
	isFocused: boolean;
	/**
	 * Set for bare numbers and for issue keys whose prefix no profile claims,
	 * where there is no choice to make — the profile comes from the fetched
	 * issue's tracker project. A claimed prefix gets the real list instead.
	 * The box stays on screen (it always does) but shows a single
	 * inert row instead of a list, so it's visibly not somewhere Enter stops.
	 */
	deferredLabel?: string;
	/** Whether `a` can swap in another agent profile. */
	hasAgentChoice: boolean;
	maxVisible: number;
}) {
	const {start, end, above, below} = computePickerWindow(
		options.length,
		selectedIndex,
		maxVisible,
	);
	const skinToneWide = useTmuxSkinToneWide();

	return (
		<box flexDirection="column">
			<TitledBox
				title="Profile"
				borderColor="green"
				titleColor="greenBright"
				borderStyle={frame.borderStyle}
				isDim={frame.isDim}
				paddingY={0}
			>
				{deferredLabel ? (
					<box flexDirection="row">
						<text {...dimText()}>{'  '}</text>
						<text
							fg={terminalColor()}
							flexShrink={1}
							attributes={textAttributes({dim: true, italic: true})}
						>
							{deferredLabel}
						</text>
					</box>
				) : null}
				{!deferredLabel && above > 0 && (
					<text {...dimText()}>↑ {above} more</text>
				)}
				{!deferredLabel && options.length === 0 && (
					<text {...dimText()}>{'  '}No match</text>
				)}
				{!deferredLabel &&
					options.slice(start, end).map((option, offset) => {
						const index = start + offset;
						const isSelected = index === selectedIndex;
						// Same slot the ticket rail uses, so a profile wears the same
						// glyph wherever it appears. Sits right of the selection caret
						// (which owns column 0 for every row) and left of the label.
						const slot = resolveEmojiSlot(
							maybeStripSkinTones(option.emoji, skinToneWide),
						);
						const agentOverride = agentOverrides[rowKey(option)];
						return (
							<box flexDirection="row" key={rowKey(option)}>
								<box flexDirection="row" flexShrink={0}>
									<text
										flexShrink={1}
										attributes={textAttributes({bold: isSelected})}
										fg={terminalColor(isSelected ? 'green' : undefined)}
									>
										{isSelected ? '❯ ' : '  '}
									</text>
								</box>
								{slot ? (
									<box flexDirection="row" flexShrink={0}>
										<text fg={terminalColor()} flexShrink={1}>
											{slot.text}
										</text>
										{slot.needsSeparator ? (
											<text fg={terminalColor()} flexShrink={1}>
												{' '}
											</text>
										) : null}
									</box>
								) : null}
								<text
									fg={terminalColor()}
									flexShrink={1}
									wrapMode="none"
									height={1}
								>
									<span
										attributes={textAttributes({
											bold: isSelected,
											italic: option.kind === 'deferred',
										})}
										fg={terminalColor(isSelected ? 'green' : undefined)}
									>
										{option.displayName}
									</span>
									{option.matchedKeywords.length > 0 && (
										<span attributes={textAttributes({dim: true})}>
											{' '}
											← {option.matchedKeywords.join(', ')}
										</span>
									)}
									{option.matchedPrefix && (
										<span attributes={textAttributes({dim: true})}>
											{' '}
											← {option.matchedPrefix}
										</span>
									)}
									{option.enforced && (
										<span fg={terminalColor('magenta')}> (enforced)</span>
									)}
									{option.isDefault && option.matchedKeywords.length === 0 && (
										<span attributes={textAttributes({dim: true})}>
											{' '}
											(default)
										</span>
									)}
								</text>
								{agentOverride && (
									<text
										flexShrink={1}
										fg={terminalColor('cyan')}
										wrapMode="none"
										height={1}
									>
										{' '}
										→ {cutAgentProfileName(agentOverride)}
									</text>
								)}
							</box>
						);
					})}
				{!deferredLabel && below > 0 && (
					<text {...dimText()}>↓ {below} more</text>
				)}
			</TitledBox>

			{isFocused && query !== null ? (
				<box flexDirection="row" paddingX={2}>
					<text fg={terminalColor()} flexShrink={1} wrapMode="none" height={1}>
						<span fg={terminalColor('cyan')}>/{query}</span>
						<span attributes={textAttributes({inverse: true})}> </span>
						<span attributes={textAttributes({dim: true})}>
							{' '}
							· <span fg={terminalColor('green')}>Enter</span> select ·{' '}
							<span fg={terminalColor('yellow')}>Esc</span> clear
						</span>
					</text>
				</box>
			) : isFocused ? (
				<box flexDirection="row" paddingX={2}>
					<text {...dimText()} wrapMode="none" height={1}>
						<span fg={terminalColor('green')}>↑/↓</span> select ·{' '}
						<span fg={terminalColor('cyan')}>/</span> filter ·{' '}
						{hasAgentChoice ? (
							<>
								<span fg={terminalColor('cyan')}>a</span> agent ·{' '}
							</>
						) : null}
						<span fg={terminalColor('green')}>Enter</span> start ·{' '}
						<span fg={terminalColor('yellow')}>Esc</span> back
					</text>
				</box>
			) : null}
		</box>
	);
}

/**
 * The slash-command list.
 *
 * It starts unfocused, because the text input owns the cursor for as long as
 * you are still typing the name. Enter hands it the focus, which freezes the
 * input and lets the arrows, `j`/`k`, and Enter itself work on the list. Tab
 * accepts from either side, so the focus is never something you have to take
 * before you can finish a name.
 */
function SkillPicker({
	entries,
	selectedIndex,
	frame,
	isFocused,
	maxVisible,
}: {
	entries: SkillEntry[];
	selectedIndex: number;
	frame: {borderStyle: 'double' | 'round'; isDim: boolean};
	isFocused: boolean;
	maxVisible: number;
}) {
	const {start, end, above, below} = computePickerWindow(
		entries.length,
		selectedIndex,
		maxVisible,
	);

	return (
		<box flexDirection="column">
			<TitledBox
				title="Skills"
				borderColor="cyan"
				titleColor="cyanBright"
				borderStyle={frame.borderStyle}
				isDim={frame.isDim}
				paddingY={0}
			>
				{above > 0 && <text {...dimText()}>↑ {above} more</text>}
				{entries.slice(start, end).map((entry, offset) => {
					const index = start + offset;
					const isSelected = index === selectedIndex;
					return (
						<box flexDirection="row" key={`${entry.source}:${entry.name}`}>
							<text
								flexShrink={1}
								attributes={textAttributes({bold: isSelected})}
								fg={terminalColor(isSelected ? 'cyan' : undefined)}
							>
								{isSelected ? '❯ ' : '  '}/{entry.name}
							</text>
							{entry.source === 'user' && <text {...dimText()}> (user)</text>}
						</box>
					);
				})}
				{below > 0 && <text {...dimText()}>↓ {below} more</text>}
			</TitledBox>

			<box flexDirection="row" paddingX={2}>
				<text {...dimText()}>
					{isFocused ? (
						<>
							<span fg={terminalColor('cyan')}>↑/↓</span> select ·{' '}
							<span fg={terminalColor('cyan')}>Enter</span> complete ·{' '}
							<span fg={terminalColor('yellow')}>Esc</span> back
						</>
					) : (
						<>
							<span fg={terminalColor('cyan')}>↑/↓</span> select ·{' '}
							<span fg={terminalColor('cyan')}>Tab</span> complete ·{' '}
							<span fg={terminalColor('yellow')}>Esc</span> dismiss
						</>
					)}
				</text>
			</box>
		</box>
	);
}
