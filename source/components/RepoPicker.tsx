import {useState} from 'react';
import {useKeyboard} from '@opentui/react';
import {
	formatShare,
	pickedRepos,
	repoPickerStep,
	repoPickerWindow,
	toggleRepo,
	type RepoChoice,
} from '../repo-picker.ts';
import {dimText, terminalColor, textAttributes} from '../tui-style.ts';
import TitledBox from './TitledBox.tsx';

type Props = {
	repos: readonly RepoChoice[];
	/** The row the list opens on. */
	initialIndex: number;
	/** The repos ticked when the list opens. */
	initialTicked?: readonly string[];
	/** The prefix of the issue key the suggested rows are for. */
	prefix?: string;
	/** Rows available to the dialog. */
	availableHeight?: number;
	/** One repo for a plain space, several for a ticket space. */
	onPick: (names: string[]) => void;
	onCancel: () => void;
};

/** Rows the frame, its padding and the hint take around the list. */
const CHROME_ROWS = 6;

/**
 * Which repos a new space is made in, asked on a rail that shows a whole
 * work dir. A list in the style of the profile picker: move, Enter. Space
 * ticks a row, and a space made in more than one repo is a ticket space.
 */
export default function RepoPicker({
	repos,
	initialIndex,
	initialTicked,
	prefix,
	availableHeight,
	onPick,
	onCancel,
}: Props) {
	const [index, setIndex] = useState(
		Math.max(0, Math.min(initialIndex, repos.length - 1)),
	);
	const [ticked, setTicked] = useState(
		() =>
			new Set(
				repos.flatMap((repo, row) =>
					initialTicked?.includes(repo.name) ? [row] : [],
				),
			),
	);
	const names = repos.map(repo => repo.name);

	useKeyboard(event => {
		const step = repoPickerStep(event, index, repos.length);
		switch (step.kind) {
			case 'move': {
				setIndex(step.index);
				break;
			}

			case 'toggle': {
				setTicked(toggleRepo(ticked, step.index));
				break;
			}

			case 'pick': {
				// A digit picks its row alone; Enter takes what is ticked.
				const picked =
					event.name === 'return'
						? pickedRepos(names, ticked, step.index)
						: pickedRepos(names, new Set(), step.index);
				if (picked.length > 0) onPick(picked);
				break;
			}

			case 'cancel': {
				onCancel();
				break;
			}

			case 'ignore': {
				break;
			}
		}
	});

	const {start, end} = repoPickerWindow(
		repos.length,
		index,
		availableHeight === undefined
			? repos.length
			: availableHeight - CHROME_ROWS,
	);
	return (
		<TitledBox
			title={ticked.size > 1 ? '+ New Ticket Space in' : '+ New Session in'}
			borderColor="green"
			titleColor="greenBright"
		>
			<box flexDirection="column">
				{repos.slice(start, end).map((repo, offset) => {
					const row = start + offset;
					const isSelected = row === index;
					const why =
						repo.share === undefined
							? repo.suggested && prefix
								? `  ← ${prefix}`
								: ''
							: `  ${formatShare(repo.share)}${prefix ? ` of ${prefix}` : ''}`;
					return (
						<text
							key={repo.name}
							wrapMode="none"
							height={1}
							fg={isSelected ? terminalColor('cyan') : undefined}
							attributes={textAttributes({bold: isSelected})}
						>
							{`${isSelected ? '❯' : ' '} ${row < 9 ? row + 1 : ' '} ${ticked.has(row) ? '[x]' : '[ ]'} ${repo.name}`}
							{why ? (
								<span attributes={textAttributes({dim: true})}>{why}</span>
							) : null}
						</text>
					);
				})}
			</box>
			<box marginTop={1}>
				<text {...dimText()} wrapMode="none" height={1}>
					j/k move · Space tick several · Enter or 1-9 pick · Esc cancel
				</text>
			</box>
		</TitledBox>
	);
}
